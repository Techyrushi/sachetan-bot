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
const upload = multer({
  dest: "uploads/",
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
        \`source_type\` ENUM('manual', 'file') DEFAULT 'manual',
        \`source_name\` VARCHAR(255) DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
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
  const { title, content } = req.body;
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
router.put("/documents/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  
  try {
    // Get doc_id first
    const [rows] = await pool.query("SELECT doc_id FROM tbl_ai_knowledge WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found." });
    const docId = rows[0].doc_id;

    // Update MySQL
    await pool.query("UPDATE tbl_ai_knowledge SET title = ?, content = ? WHERE id = ?", [title, content, id]);

    // Update Pinecone (Upsert overwrites)
    await upsertDocuments([{ id: docId, text: content, metadata: { title, source: "updated_manual" } }]);

    res.json({ success: true, message: "Document updated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. DELETE DOCUMENT
router.delete("/documents/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query("SELECT doc_id FROM tbl_ai_knowledge WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found." });
    const docId = rows[0].doc_id;

    // Delete from Pinecone
    const pineconeDeleted = await deleteDocument(docId);
    if (!pineconeDeleted) {
        // We throw an error so the user knows it failed. 
        // We do NOT delete from MySQL so the user can try again.
        throw new Error("Failed to delete from AI database (Pinecone). Please try again.");
    }

    // Delete from MySQL
    await pool.query("DELETE FROM tbl_ai_knowledge WHERE id = ?", [id]);

    res.json({ success: true, message: "Document deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
