const express = require("express");
const router = express.Router();
const multer = require("multer");
const xlsx = require("xlsx");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const pool = require("../config/mysql");
const { upsertDocuments, deleteDocument } = require("../utils/rag");
const auth = require("../middleware/auth");

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "../public/uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Sanitize filename: remove special chars, keep extension
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext)
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
    const timestamp = Date.now();
    cb(null, `${name}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Ensure table exists (Auto-migration)
async function ensureTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`tbl_ai_knowledge\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`doc_id\` VARCHAR(255) NOT NULL UNIQUE,
        \`title\` VARCHAR(255) NOT NULL,
        \`content\` TEXT NOT NULL,
        \`source_type\` VARCHAR(50) DEFAULT 'manual',
        \`source_name\` VARCHAR(255) DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    
    // Migration: Ensure source_type is VARCHAR (in case it was ENUM)
    await pool.query("ALTER TABLE tbl_ai_knowledge MODIFY COLUMN source_type VARCHAR(50) DEFAULT 'manual'");
    
    // Migration: Ensure source_name can hold multiple URLs (TEXT)
    await pool.query("ALTER TABLE tbl_ai_knowledge MODIFY COLUMN source_name TEXT DEFAULT NULL");
    
  } catch (err) {
    console.error("Auto-migration failed:", err.message);
  }
}
ensureTable();

// 1. LIST ALL DOCUMENTS
router.get("/documents", auth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tbl_ai_knowledge ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ADD MANUAL TEXT
router.post("/manual", auth, async (req, res) => {
  let { title, content } = req.body;
  let updatedContent = content;
  if (!title || !content) return res.status(400).json({ error: "Title and content are required." });

  const docId = `doc_${Date.now()}`;
  try {
    // 1. Add to MySQL
    await pool.query(
      "INSERT INTO tbl_ai_knowledge (doc_id, title, content, source_type) VALUES (?, ?, ?, 'manual')",
      [docId, title, content]
    );

    // 2. Add to Pinecone
    try {
      await upsertDocuments([{ id: docId, text: content, metadata: { title, source: "manual" } }]);
    } catch (pineconeError) {
      console.error("Pinecone upsert failed, rolling back MySQL:", pineconeError);
      await pool.query("DELETE FROM tbl_ai_knowledge WHERE doc_id = ?", [docId]);
      throw new Error("Failed to train AI. Please try again.");
    }

    res.json({ success: true, message: "Knowledge added successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. UPLOAD FILE (TXT, CSV, EXCEL)
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const title = req.body.title || req.file.originalname;
  let content = "";

  try {
    if (ext === ".txt") {
      content = fs.readFileSync(filePath, "utf-8");
    } else if (ext === ".xlsx" || ext === ".xls") {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      content = xlsx.utils.sheet_to_csv(sheet);
    } else if (ext === ".csv") {
      const results = [];
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (data) => results.push(Object.values(data).join(" ")))
          .on("end", () => {
            content = results.join("\n");
            resolve();
          })
          .on("error", reject);
      });
    } else {
      throw new Error("Unsupported file format. Use .txt, .csv, or .xlsx");
    }

    if (!content.trim()) throw new Error("File is empty.");

    const docId = `file_${Date.now()}`;
    
    // 1. Add to MySQL
    await pool.query(
      "INSERT INTO tbl_ai_knowledge (doc_id, title, content, source_type, source_name) VALUES (?, ?, ?, 'file', ?)",
      [docId, title, content, req.file.originalname]
    );

    // 2. Add to Pinecone
    try {
      await upsertDocuments([{ id: docId, text: content, metadata: { title, source: req.file.originalname } }]);
    } catch (pineconeError) {
      console.error("Pinecone upload failed, rolling back MySQL:", pineconeError);
      await pool.query("DELETE FROM tbl_ai_knowledge WHERE doc_id = ?", [docId]);
      throw new Error("Failed to sync with AI database. Please try again.");
    }

    res.json({ success: true, message: "File processed and AI trained successfully." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Cleanup
  }
});

// 4. UPDATE DOCUMENT
router.put("/documents/:id", auth, upload.array("images", 10), async (req, res) => {
  const { id } = req.params;
  let { title, content } = req.body;
  let updatedContent = content;
  
  try {
    // Get doc info first
    const [rows] = await pool.query("SELECT doc_id, source_type, source_name FROM tbl_ai_knowledge WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found." });
    const { doc_id, source_type, source_name } = rows[0];

    // Prepare Metadata
    let metadata = { title, source: "updated_manual" };

    // Preserve Product Metadata if applicable
    if (source_type === 'product') {
        const priceMatch = updatedContent.match(/Price:\s*(.+)/i);
        const price = priceMatch ? priceMatch[1].trim() : "";
        
        let newImageUrls = source_name; // Keep existing by default
        
        // If new images are uploaded, REPLACE existing
        if (req.files && req.files.length > 0) {
            const urls = req.files.map(file => `${process.env.BASE_URL}/uploads/${file.filename}`);
            newImageUrls = urls.join(","); // Comma separated for DB
        }

        // Update source_name if changed
        if (newImageUrls !== source_name) {
            await pool.query("UPDATE tbl_ai_knowledge SET source_name = ? WHERE id = ?", [newImageUrls, id]);
        }

        // Remove old Image Available lines
        updatedContent = updatedContent.replace(/Image Available:.*(\n|$)/g, "").trim();

        // Add new Image Available lines
        const urlsArray = newImageUrls ? newImageUrls.split(",") : [];
        if (urlsArray.length > 0) {
            updatedContent += "\n\n" + urlsArray.map(url => `Image Available: ${url}`).join("\n");
        }

        metadata = {
            title,
            source: "admin_product_updated",
            type: "product",
            imageUrl: newImageUrls, // Might be CSV
            price: price
        };
    }

    // Update MySQL
    await pool.query("UPDATE tbl_ai_knowledge SET title = ?, content = ? WHERE id = ?", [title, updatedContent, id]);

    // Update Pinecone (Upsert overwrites)
    await upsertDocuments([{ id: doc_id, text: updatedContent, metadata }]);

    res.json({ success: true, message: "Document updated successfully.", imageUrl: source_type === 'product' ? metadata.imageUrl : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. DELETE DOCUMENT
router.delete("/documents/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query("SELECT doc_id, source_type, source_name FROM tbl_ai_knowledge WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found." });
    const { doc_id, source_type, source_name } = rows[0];

    // Delete from Pinecone
    const pineconeDeleted = await deleteDocument(docId);
    if (!pineconeDeleted) {
        // We throw an error so the user knows it failed. 
        // We do NOT delete from MySQL so the user can try again.
        throw new Error("Failed to delete from AI database (Pinecone). Please try again.");
    }

    // Delete physical files if product/file
    if ((source_type === 'product' || source_type === 'file') && source_name) {
        // source_name can be comma-separated URLs (product) or filename (file)
        let filenames = [];
        
        if (source_type === 'product') {
            // Extract filenames from URLs
            const urls = source_name.split(",");
            filenames = urls.map(url => {
                const parts = url.split("/uploads/");
                return parts.length > 1 ? parts[1] : null;
            }).filter(Boolean);
        } else {
            // source_type === 'file', source_name is likely the original filename, 
            // BUT we stored the sanitized unique filename in uploads. 
            // Actually, for 'file', we didn't store the unique filename in DB, we only stored originalName in source_name.
            // Wait, looking at upload route: source_name is req.file.originalname.
            // The unique filename is NOT stored in DB for files, only for products (in URL).
            // For 'file' type, we can't reliably delete the file unless we query by content or store the unique filename.
            // However, for PRODUCTS, we definitely have the full URL in source_name.
            
            // NOTE: For now, we will only delete product images as they have full paths.
        }

        filenames.forEach(filename => {
            const filePath = path.join(__dirname, "../public/uploads", filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted file: ${filePath}`);
            }
        });
    }

    // Delete from MySQL
    await pool.query("DELETE FROM tbl_ai_knowledge WHERE id = ?", [id]);

    res.json({ success: true, message: "Document deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. ADD PRODUCT (Image + Text)
router.post("/product", auth, upload.array("images", 10), async (req, res) => {
  const { name, description, price, category } = req.body;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Product image is required." });

  // Handle multiple images
  const imageUrls = req.files.map(file => `${process.env.BASE_URL}/uploads/${file.filename}`);
  const imageUrlsString = imageUrls.join(",");
  
  // Create text with all images
  const imageLines = imageUrls.map(url => `Image Available: ${url}`).join("\n");
  const text = `Product: ${name}\nCategory: ${category}\nPrice: ${price}\nDescription: ${description}\n${imageLines}`;
  
  const docId = `prod_${Date.now()}`;

  try {
    // 1. Add to MySQL
    await pool.query(
      "INSERT INTO tbl_ai_knowledge (doc_id, title, content, source_type, source_name) VALUES (?, ?, ?, 'product', ?)",
      [docId, name, text, imageUrlsString]
    );

    // 2. Add to Pinecone
    try {
      await upsertDocuments([{ 
          id: docId, 
          text: text, 
          metadata: { 
              title: name, 
              source: "admin_product", 
              type: "product",
              imageUrl: imageUrlsString,
              price: price
          } 
      }]);
    } catch (pineconeError) {
      console.error("Pinecone upsert failed:", pineconeError);
      // Rollback
      await pool.query("DELETE FROM tbl_ai_knowledge WHERE doc_id = ?", [docId]);
      throw new Error("Failed to sync product with AI.");
    }

    res.json({ success: true, message: "Product added and AI trained successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
