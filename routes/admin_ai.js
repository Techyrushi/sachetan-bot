const express = require("express");
const router = express.Router();
const multer = require("multer");
const xlsx = require("xlsx");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const pool = require("../config/mysql");
const sendWhatsApp = require("../utils/sendWhatsApp");
const { upsertDocuments, deleteDocument } = require("../utils/rag");
const auth = require("../middleware/auth");
const PDFDocument = require("pdfkit");
const { logQuotation } = require("../utils/sheets");

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

// Normalize different phone formats to Twilio WhatsApp E.164 format
function normalizeWhatsAppNumber(input) {
  if (!input) return null;
  let s = String(input).trim();
  // Remove existing whatsapp: prefix if present
  if (s.toLowerCase().startsWith("whatsapp:")) {
    s = s.slice("whatsapp:".length).trim();
  }
  // Convert leading 00 to +
  if (s.startsWith("00")) {
    s = "+" + s.slice(2);
  }
  // Remove all non-digits except leading +
  s = s.replace(/(?!^\+)[^\d]/g, "");
  // If it doesn't start with +, try to infer
  if (!s.startsWith("+")) {
    // If 10 digits, assume India
    const digitsOnly = s.replace(/[^\d]/g, "");
    if (digitsOnly.length === 10) {
      s = "+91" + digitsOnly;
    } else if (digitsOnly.length >= 11 && digitsOnly.length <= 15) {
      // Assume already includes country code, add +
      s = "+" + digitsOnly;
    } else {
      return null;
    }
  }
  return `whatsapp:${s}`;
}

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
  let { title, content, userType } = req.body;
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
      const type = userType || "all";
      await upsertDocuments([{ id: docId, text: content, metadata: { title, source: "manual", type } }]);
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

// 3. UPLOAD FILE (TXT, CSV, EXCEL) WITH OPTIONAL IMAGES
router.post("/upload", auth, upload.fields([{ name: "file", maxCount: 1 }, { name: "images", maxCount: 10 }]), async (req, res) => {
  const fileInfo = (req.files && req.files.file && req.files.file[0]) || req.file;
  if (!fileInfo) return res.status(400).json({ error: "No file uploaded." });

  const filePath = fileInfo.path;
  const ext = path.extname(fileInfo.originalname).toLowerCase();
  const title = req.body.title || fileInfo.originalname;
  const userType = (req.body.userType || "").trim();
  let content = "";

  try {
    if (ext === ".txt") {
      content = fs.readFileSync(filePath, "utf-8");
    } else if (ext === ".xlsx" || ext === ".xls") {
      const workbook = xlsx.readFile(filePath);
      // Iterate over all sheets
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const sheetContent = xlsx.utils.sheet_to_csv(sheet);
        if (sheetContent && sheetContent.trim()) {
          content += `\n--- Sheet: ${sheetName} ---\n${sheetContent}`;
        }
      });
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

    // Handle optional images: append "Image Available: <url>" lines to content
    const imageFiles = (req.files && req.files.images) || [];
    const imageUrls = imageFiles.map(f => `${process.env.BASE_URL}/uploads/${f.filename}`);
    if (imageUrls.length > 0) {
      const imageLines = imageUrls.map(url => `Image Available: ${url}`).join("\n");
      content = `${content}\n\n${imageLines}`.trim();
    }

    const docId = `file_${Date.now()}`;
    
    // 1. Add to MySQL
    await pool.query(
      "INSERT INTO tbl_ai_knowledge (doc_id, title, content, source_type, source_name) VALUES (?, ?, ?, 'file', ?)",
      [docId, title, content, fileInfo.originalname]
    );

    // 2. Add to Pinecone
    try {
      const metadata = { title, source: fileInfo.originalname };
      if (imageUrls.length > 0) {
        metadata.imageUrl = imageUrls.join(",");
      }
      metadata.type = userType || "all";
      await upsertDocuments([{ id: docId, text: content, metadata }]);
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
    // Note: Uploaded images are intentionally retained in /uploads and referenced by URL
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
    await pool.query("UPDATE tbl_ai_knowledge SET title = ?, content = ?, source_type = ? WHERE id = ?", [title, updatedContent, source_type, id]);

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
    console.log(`[Admin] Deleting doc from Pinecone: ${doc_id}`);
    const pineconeDeleted = await deleteDocument(doc_id);
    if (!pineconeDeleted) {
        // We throw an error so the user knows it failed. 
        // We do NOT delete from MySQL so the user can try again.
        throw new Error("Failed to delete from AI database (Pinecone). Please try again.");
    }
    console.log(`[Admin] Pinecone delete OK: ${doc_id}`);

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
    console.log(`[Admin] Deleting row from MySQL: id=${id}`);
    await pool.query("DELETE FROM tbl_ai_knowledge WHERE id = ?", [id]);
    console.log(`[Admin] MySQL delete OK: id=${id}`);

    res.json({ success: true, message: "Document deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. ADD PRODUCT (Image + Text)
router.post("/product", auth, upload.array("images", 10), async (req, res) => {
  const { name, description, price, category, userType } = req.body;
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
              type: userType || "Homebakers",
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

// 7. GET CHAT USERS (SESSIONS)
router.get("/chat/users", auth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tbl_chat_sessions ORDER BY last_message_at DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. GET CHAT HISTORY FOR A USER
router.get("/chat/history/:phone", auth, async (req, res) => {
  const { phone } = req.params;
  try {
    const [rows] = await pool.query("SELECT * FROM tbl_chat_history WHERE phone = ? ORDER BY created_at ASC", [phone]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. START MANUAL CHAT (TAKEOVER)
router.post("/chat/manual/start", auth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  try {
    const [rows] = await pool.query("SELECT stage FROM tbl_chat_sessions WHERE phone = ? LIMIT 1", [phone]);
    const prevStage = rows.length ? rows[0].stage : null;
    await pool.query(
      "INSERT INTO tbl_chat_sessions (phone, stage, previous_stage) VALUES (?, 'manual', ?) ON DUPLICATE KEY UPDATE previous_stage=VALUES(previous_stage), stage='manual', last_message_at=NOW()",
      [phone, prevStage]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. STOP MANUAL CHAT (RELEASE TO AI)
router.post("/chat/manual/stop", auth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  try {
    await pool.query(
      "INSERT INTO tbl_chat_sessions (phone, stage) VALUES (?, 'menu') ON DUPLICATE KEY UPDATE stage=COALESCE(previous_stage,'menu'), previous_stage=NULL, last_message_at=NOW()",
      [phone]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. SEND ADMIN MESSAGE
router.post("/chat/send", auth, upload.array('files', 10), async (req, res) => {
  const { phone, message } = req.body;
  const files = req.files || [];

  if (!phone || (!message && files.length === 0)) {
      return res.status(400).json({ error: "phone and message or files required" });
  }
  
  try {
    const to = normalizeWhatsAppNumber(phone);
    if (!to) return res.status(400).json({ error: "Invalid phone format" });
    // Case 1: Text only
    if (files.length === 0) {
        await sendWhatsApp(to, message);
        await pool.query("INSERT INTO tbl_chat_history (phone, sender, message, media_url, created_at) VALUES (?, 'admin', ?, NULL, NOW())", [to, message]);
    } 
    // Case 2: Files (with optional text attached to first one)
    else {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const mediaUrl = `${process.env.BASE_URL}/uploads/${file.filename}`;
            const body = (i === 0) ? (message || "") : ""; // Attach text to first file only

            await sendWhatsApp(to, body, { mediaUrl });
            
            await pool.query(
                "INSERT INTO tbl_chat_history (phone, sender, message, media_url, created_at) VALUES (?, 'admin', ?, ?, NOW())", 
                [to, body, mediaUrl]
            );
        }
    }

    await pool.query("INSERT INTO tbl_chat_sessions (phone, stage) VALUES (?, 'manual') ON DUPLICATE KEY UPDATE last_message_at=NOW()", [to]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 12. BULK MESSAGE SEND
router.post("/bulk-message", auth, upload.fields([{ name: "file", maxCount: 1 }, { name: "attachment", maxCount: 1 }]), async (req, res) => {
  const fileInfo = req.files && req.files.file ? req.files.file[0] : null;
  const attachment = req.files && req.files.attachment ? req.files.attachment[0] : null;
  const { message } = req.body;

  if (!fileInfo) return res.status(400).json({ error: "Contact list file (Excel/CSV) is required." });
  if (!message) return res.status(400).json({ error: "Message content is required." });

  const filePath = fileInfo.path;
  const ext = path.extname(fileInfo.originalname).toLowerCase();
  let contacts = [];

  try {
    // 1. Parse File
    if (ext === ".xlsx" || ext === ".xls") {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      contacts = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else if (ext === ".csv") {
      contacts = [];
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (data) => contacts.push(data))
          .on("end", resolve)
          .on("error", reject);
      });
    } else {
      throw new Error("Unsupported file format. Use .csv or .xlsx");
    }

    if (!contacts.length) throw new Error("File is empty.");

    // 2. Validate Columns
    // We expect "Name" and "Contact Number" (case insensitive normalization needed)
    // Let's normalize keys to lowercase
    const normalizedContacts = contacts.map(row => {
        const newRow = {};
        Object.keys(row).forEach(key => {
            newRow[key.trim().toLowerCase()] = row[key];
        });
        return newRow;
    });

    // 3. Send Messages
    let sentCount = 0;
    let failedCount = 0;
    const mediaUrl = attachment ? `${process.env.BASE_URL}/uploads/${attachment.filename}` : null;

    for (const contact of normalizedContacts) {
        // Find phone number column (contact number, phone, mobile, etc.)
        const phoneKey = Object.keys(contact).find(k => k.includes("contact") || k.includes("phone") || k.includes("mobile") || k.includes("number"));
        let phone = phoneKey ? contact[phoneKey] : null;

        if (phone) {
            // Normalize to WhatsApp E.164 format
            const to = normalizeWhatsAppNumber(phone);
            if (!to) {
              failedCount++;
              continue;
            }
            
            // Variable Substitution
            let personalizedMessage = message;
            // Replace {{name}} with Name
            const nameKey = Object.keys(contact).find(k => k.includes("name"));
            const name = nameKey ? contact[nameKey] : "Customer";
            personalizedMessage = personalizedMessage.replace(/{{name}}/gi, name);

            // Twilio Content Variables rules:
            // - Variables cannot contain newlines/tabs or be empty/null.
            // - So we sanitize the dynamic text to a single-line string.
            const sanitizedMessage = String(personalizedMessage || "")
              .replace(/\s+/g, " ")
              .trim();
            const safeName = String(name || "Customer").trim() || "Customer";
            // We will not use a separate template variable for media to keep
            // variable count simple and aligned with the template (only {{1}} and {{2}})

            // Send (prefer WhatsApp Template if configured, to avoid 24h session limit issues)
            try {
                const options = {};
                if (mediaUrl) {
                  options.mediaUrl = mediaUrl;
                }

                const bulkTemplateSid = process.env.TWILIO_CONTENT_SID_BULK;
                let bodyToSend = personalizedMessage;

                if (bulkTemplateSid) {
                  options.contentSid = bulkTemplateSid;
                  options.contentVariables = {
                    "1": safeName,
                    "2": sanitizedMessage || "-",
                  };
                  bodyToSend = "";
                }

                await sendWhatsApp(to, bodyToSend, options);
                if (mediaUrl && bulkTemplateSid) {
                  try {
                    await sendWhatsApp(to, "", { mediaUrl });
                  } catch (mediaErr) {
                    console.error(`Failed to send media to ${to}:`, mediaErr.message);
                  }
                }
                await pool.query(
                    "INSERT INTO tbl_chat_history (phone, sender, message, media_url, created_at) VALUES (?, 'admin_bulk', ?, ?, NOW())", 
                    [to, personalizedMessage, mediaUrl]
                );
                sentCount++;
            } catch (e) {
                console.error(`Failed to send to ${to}:`, e.message);
                failedCount++;
            }
        } else {
            failedCount++; // No phone number found in row
        }
    }

    res.json({ 
        success: true, 
        message: `Bulk sending completed. Sent: ${sentCount}, Failed: ${failedCount}`,
        stats: { sent: sentCount, failed: failedCount }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup uploaded contact list (keep attachment)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
  }
});

// 13. GENERATE AND SEND QUOTATION
router.post("/chat/quotation", auth, async (req, res) => {
  const { phone, customerName, customerCity, items, gstRate, manualTotal } = req.body;

  if (!phone || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const doc = new PDFDocument({ margin: 50 });
    const filename = `quotation_${phone.replace(/[^0-9]/g, "")}_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, "../public/quotations", filename);
    const writeStream = fs.createWriteStream(filePath);

    doc.pipe(writeStream);

    // --- PDF CONTENT GENERATION ---
    const primaryColor = "#2E7D32"; // Eco Green
    const secondaryColor = "#1B5E20"; // Darker Green
    const accentColor = "#E8F5E9"; // Light Green Background
    const greyColor = "#444444";
    const lightGrey = "#f5f5f5";
    const borderColor = "#dddddd";

    // 1. Top Decorative Bar
    doc.rect(0, 0, 612, 20).fill(primaryColor);

    // 2. Header with Logo
    const logoPath = path.join(__dirname, "../public/assets/sachetan_logo.png");
    if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 80 });
    }

    // 3. Business Header
    doc.fillColor(primaryColor)
       .fontSize(26)
       .font("Helvetica-Bold")
       .text("SACHETAN", 150, 50)
       .fontSize(10)
       .font("Helvetica")
       .fillColor(secondaryColor)
       .text("Eco-Friendly Packaging Solutions", 150, 78)
       .moveDown(0.5);

    doc.fillColor(greyColor)
       .fontSize(9)
       .text("Plot No. J30, Near Jai Malhar Hotel, MIDC, Sinnar 422106", 150, 95)
       .text("Email: sagar9994@rediffmail.com", 150, 108)
       .text("Ph: +91 92263 22231 | +91 84460 22231", 150, 121);
       
    doc.fillColor("#0000EE") // Link Blue
       .font("Helvetica-Bold")
       .text("Website: https://sachetanpackaging.in", 150, 134, { link: "https://sachetanpackaging.in", underline: true });

    // 4. Quotation Title & Date Box
    doc.rect(400, 45, 160, 60).fill(accentColor).stroke(primaryColor);
    doc.fillColor(primaryColor)
       .fontSize(18)
       .font("Helvetica-Bold")
       .text("QUOTATION", 400, 55, { width: 160, align: "center" });
       
    doc.fillColor("black")
       .fontSize(10)
       .font("Helvetica")
       .text(`Date: ${new Date().toLocaleDateString()}`, 400, 80, { width: 160, align: "center" })
       .text(`Ref: Q-${Date.now().toString().slice(-6)}`, 400, 95, { width: 160, align: "center" });

    // 5. Customer Details Section
    const customerBoxY = 170;
    const customerBoxHeight = 85; // Increased height for dynamic content
    doc.rect(50, customerBoxY, 512, customerBoxHeight).fill(lightGrey).stroke(borderColor);
    doc.fillColor(secondaryColor)
       .font("Helvetica-Bold")
       .fontSize(11)
       .text("Customer Details:", 60, customerBoxY + 10);
       
    let detailsY = customerBoxY + 30;
    
    // Name
    doc.fillColor("black")
       .font("Helvetica-Bold")
       .fontSize(10)
       .text(customerName || "Customer", 60, detailsY, { width: 400 });
       
    // Measure name height to avoid overlap
    const nameHeight = doc.heightOfString(customerName || "Customer", { width: 400 });
    detailsY += nameHeight + 5;

    // City
    doc.font("Helvetica").fontSize(10);
    if (customerCity) {
        doc.text(`City: ${customerCity}`, 60, detailsY);
        detailsY += 15;
    }
    
    // Phone
    doc.text(`Phone: ${phone}`, 60, detailsY);

    // 6. Table Header
    const tableTop = customerBoxY + customerBoxHeight + 20; // 170 + 70 + 20 = 260
    const itemX = 60;
    const sizeX = 240;
    const qtyX = 320;
    const rateX = 390;
    const amountX = 480;

    doc.rect(50, tableTop, 512, 25).fill(primaryColor);
    
    doc.fillColor("white")
       .font("Helvetica-Bold")
       .fontSize(10)
       .text("Item Description", itemX, tableTop + 7)
       .text("Size", sizeX, tableTop + 7)
       .text("Qty", qtyX, tableTop + 7)
       .text("Rate", rateX, tableTop + 7)
       .text("Amount", amountX, tableTop + 7);
    
    // 7. Items Loop
    let y = tableTop + 30;
    let subtotal = 0;

    doc.fillColor("black").font("Helvetica").fontSize(10);

    items.forEach((item, index) => {
        const productName = item.name || item.product || "Product";
        const size = item.size || "-";
        const qty = Number(item.qty || item.quantity) || 0;
        const rate = Number(item.rate) || 0;
        const discount = Number(item.discount) || 0; 
        
        const lineAmount = (qty * rate) - discount;
        const finalAmount = Math.max(0, lineAmount);
        
        subtotal += finalAmount;

        // Alternating row background
        if (index % 2 === 0) {
            doc.rect(50, y - 5, 512, 20).fill("#f9f9f9");
            doc.fillColor("black");
        }

        // Cell Borders (optional, let's keep it clean with just background)
        // doc.rect(50, y - 5, 512, 20).stroke(borderColor);

        doc.text(productName, itemX, y, { width: 170, lineBreak: false, ellipsis: true });
        doc.text(size, sizeX, y);
        doc.text(qty.toString(), qtyX, y);
        doc.text(rate.toFixed(2), rateX, y);
        doc.text(finalAmount.toFixed(2), amountX, y);
        
        y += 25;
        
        // Dynamic Page Break
        if (y > 600) { // Reduced from 680 to prevent overlap with taller footer
            doc.addPage();
            // Re-draw top bar on new page
            doc.rect(0, 0, 612, 20).fill(primaryColor);
            y = 50; 
            
            // Re-draw table header on new page
            doc.rect(50, y, 512, 25).fill(primaryColor);
            doc.fillColor("white").font("Helvetica-Bold");
            doc.text("Item Description", itemX, y + 7)
               .text("Size", sizeX, y + 7)
               .text("Qty", qtyX, y + 7)
               .text("Rate", rateX, y + 7)
               .text("Amount", amountX, y + 7);
            doc.fillColor("black").font("Helvetica");
            y += 30;
        }
    });

    // Bottom Line for Table
    doc.moveTo(50, y).lineTo(562, y).strokeColor(primaryColor).lineWidth(1).stroke();
    y += 15;

    // 8. Totals Section
    if (y > 530) { // Adjusted threshold to ensure Totals move with Footer if space is tight
        doc.addPage();
        doc.rect(0, 0, 612, 20).fill(primaryColor);
        y = 50;
    }

    const effectiveGstRate = gstRate > 1 ? gstRate / 100 : gstRate;
    const gstAmount = subtotal * effectiveGstRate;
    const calculatedTotal = subtotal + gstAmount;
    const finalTotal = manualTotal || calculatedTotal;

    const rightColX = 350;
    const valColX = 460;

    doc.font("Helvetica");
    doc.text("Subtotal:", rightColX, y);
    doc.text(subtotal.toFixed(2), valColX, y, { align: "right", width: 80 });
    y += 18;
    
    doc.text(`GST (${(effectiveGstRate * 100).toFixed(0)}%):`, rightColX, y);
    doc.text(gstAmount.toFixed(2), valColX, y, { align: "right", width: 80 });
    y += 25;
    
    // Total Box
    doc.rect(rightColX - 10, y - 8, 200, 30).fill(primaryColor);
    doc.fillColor("white").font("Helvetica-Bold").fontSize(12);
    doc.text("Total:", rightColX, y);
    doc.text(`Rs. ${finalTotal.toFixed(2)}`, valColX - 20, y, { align: "right", width: 100 });
    
    // 9. Stylish Footer
    const pageHeight = doc.page.height;
    const footerHeight = 150; // Increased height to move footer up
    const footerY = pageHeight - footerHeight;

    // Check overlap
    if (y > footerY - 20) {
        doc.addPage();
        doc.rect(0, 0, 612, 20).fill(primaryColor);
    }

    // Footer Background
    doc.rect(0, footerY, 612, footerHeight).fill(accentColor);
    
    // Footer Content
    const footerContentY = footerY + 20;
    
    doc.fillColor(secondaryColor).font("Helvetica-Bold").fontSize(10);
    doc.text("Terms & Conditions:", 50, footerContentY);
    
    doc.fillColor(greyColor).font("Helvetica").fontSize(9);
    const termSpacing = 15;
    doc.text("1. Prices are valid for 7 days from the date of quotation.", 50, footerContentY + 20);
    doc.text("2. 50% advance payment required for order confirmation.", 50, footerContentY + 20 + termSpacing);
    doc.text("3. Goods once sold will not be taken back or exchanged.", 50, footerContentY + 20 + termSpacing * 2);
    doc.text("4. Delivery subject to availability of stock.", 50, footerContentY + 20 + termSpacing * 3);

    // Bottom Branding Bar
    doc.rect(0, pageHeight - 25, 612, 25).fill(secondaryColor);
    doc.fillColor("white").font("Helvetica-Bold").fontSize(9);
    doc.text("Thank you for choosing Sachetan Packaging!", 0, pageHeight - 18, { align: "center" });

    doc.end();

    writeStream.on("finish", async () => {
        // Send WhatsApp
        // Use BASE_URL if available, otherwise assume local/ngrok needs configuration
        const baseUrl = process.env.BASE_URL || "http://localhost:4000";
        const publicUrl = `${baseUrl}/quotations/${filename}`;
        
        const message = `Dear ${customerName || "Customer"}, please find your quotation attached.`;
        const to = normalizeWhatsAppNumber(phone);

        if (!to) {
            return res.status(400).json({ error: "Invalid phone number" });
        }
        
        try {
            await sendWhatsApp(to, message, { mediaUrl: publicUrl });
            
            // Log to Sheets
            await logQuotation({
                phone: to,
                customerName,
                totalAmount: finalTotal,
                pdfUrl: publicUrl
            });
            
            // Save to Chat History
            await pool.query(
                "INSERT INTO tbl_chat_history (phone, sender, message, media_url, created_at) VALUES (?, 'admin', ?, ?, NOW())", 
                [to, "Sent Quotation PDF", publicUrl]
            );

            res.json({ success: true, url: publicUrl });
        } catch (err) {
            console.error("Error sending WhatsApp:", err);
            res.status(500).json({ error: "Failed to send WhatsApp", details: err.message });
        }
    });

    writeStream.on("error", (err) => {
        console.error("Error generating PDF:", err);
        res.status(500).json({ error: "Failed to generate PDF" });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
