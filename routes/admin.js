const express = require("express");
const router = express.Router();
 
const Booking = require("../models/Booking");
const auth = require("../middleware/auth");
const sendWhatsApp = require("../utils/sendWhatsApp");
const Category = require("../models/Category");
const Product = require("../models/Product");
const Order = require("../models/Order");
const fs = require("fs");
const path = require("path");
 
const { upsertDocuments, queryRag, ensureCollection, pingChroma, testOpenRouter, getChromaUrl } = require("../utils/rag");
const { scrapeUrl, chunkText } = require("../utils/scraper");
const mysqlPool = require("../config/mysql");
const allowedTables = new Set([
  "tbl_product",
  "tbl_product_photo",
  "tbl_product_color",
  "tbl_product_size",
  "tbl_product_qty",
  "tbl_size",
  "tbl_color",
  "tbl_quantity",
  "tbl_top_category",
  "tbl_mid_category",
  "tbl_end_category",
  "tbl_page",
  "tbl_service",
  "feedback",
  "tbl_rating",
  "tbl_scraped_pages",
]);
async function fetchAllFromTable(table) {
  if (!allowedTables.has(table)) throw new Error("Table not allowed");
  const [rows] = await mysqlPool.query(`SELECT * FROM \`${table}\``);
  return rows;
}
router.get("/sql/:table", auth, async (req, res) => {
  try {
    const table = req.params.table;
    const rows = await fetchAllFromTable(table);
    res.json({ table, count: rows.length, rows });
  } catch (err) {
    res.status(400).json({ message: "Failed", error: err.message });
  }
});

router.get("/health", async (req, res) => {
  const health = { mysql: false, mongo: false, chroma: false, openrouter: false };
  try {
    const [rows] = await mysqlPool.query("SELECT 1 AS ok");
    health.mysql = Array.isArray(rows);
  } catch {}
  try {
    const mongoose = require("mongoose");
    health.mongo = mongoose.connection && mongoose.connection.readyState === 1;
  } catch {}
  try {
    health.chroma = await pingChroma();
  } catch {}
  try {
    health.openrouter = await testOpenRouter();
  } catch {}
  res.json({ ok: true, health, chroma_url: getChromaUrl(), env_chroma_url: process.env.CHROMA_URL });
});

router.post("/rag/upsert", auth, async (req, res) => {
  try {
    const docs = Array.isArray(req.body.docs) ? req.body.docs : [];
    if (!docs.length) return res.status(400).json({ message: "docs array required" });
    const result = await upsertDocuments(docs);
    res.json({ ok: true, count: docs.length, result });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});

router.post("/rag/scrape", auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: "URL is required" });

    const scraped = await scrapeUrl(url);

    // Store in MySQL
    try {
      await mysqlPool.query(
        "INSERT INTO `tbl_scraped_pages` (`url`, `title`, `content`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `title` = VALUES(`title`), `content` = VALUES(`content`), `created_at` = CURRENT_TIMESTAMP",
        [url, scraped.title, scraped.content]
      );
    } catch (sqlErr) {
      console.error("Failed to store scraped page in MySQL:", sqlErr.message);
      // Continue to RAG upsert even if SQL storage fails (optional, but robust)
    }

    const chunks = chunkText(scraped.content);
    
    const docs = chunks.map((chunk, i) => ({
      id: `web_${Buffer.from(url).toString("base64").substring(0, 20)}_${i}`,
      text: chunk,
      metadata: {
        source: "website",
        url: url,
        title: scraped.title,
        chunk_index: i
      }
    }));

    const result = await upsertDocuments(docs);
    res.json({ ok: true, count: docs.length, title: scraped.title, result });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});

router.post("/rag/sync-products", auth, async (req, res) => {
  try {
    // Fetch products from MySQL
    const [products] = await mysqlPool.query(`
      SELECT p.p_id, p.p_name, p.p_current_price, p.p_description, p.p_feature,
             ec.ecat_name, mc.mcat_name, tc.tcat_name
      FROM tbl_product p
      LEFT JOIN tbl_end_category ec ON p.ecat_id = ec.ecat_id
      LEFT JOIN tbl_mid_category mc ON ec.mcat_id = mc.mcat_id
      LEFT JOIN tbl_top_category tc ON mc.tcat_id = tc.tcat_id
      WHERE p.p_is_active = 1
    `);

    if (!products.length) return res.json({ ok: true, count: 0, message: "No active products found" });

    const docs = products.map(p => {
      const text = `Product: ${p.p_name}
Category: ${p.tcat_name} > ${p.mcat_name} > ${p.ecat_name}
Price: ₹${p.p_current_price}
Description: ${p.p_description || ""}
Features: ${p.p_feature || ""}
`.trim();

      return {
        id: `prod_${p.p_id}`,
        text: text,
        metadata: {
          source: "database",
          type: "product",
          product_id: p.p_id,
          name: p.p_name || "Unknown Product",
          category: p.ecat_name || "Uncategorized"
        }
      };
    });

    // Upsert in batches to avoid payload limits
    const batchSize = 50;
    let total = 0;
    
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      await upsertDocuments(batch);
      total += batch.length;
    }

    // Also sync Pages automatically for convenience
    try {
        const [pages] = await mysqlPool.query("SELECT * FROM `tbl_page` LIMIT 1");
        if (pages && pages.length) {
            const p = pages[0];
            const pageDocs = [];
            function pushDoc(id, text) {
                if (text && String(text).trim().length > 0) {
                    pageDocs.push({ id, text: String(text), metadata: { source: "tbl_page" } });
                }
            }
            pushDoc("about_content", p.about_content);
            pushDoc("products_meta_description", p.products_meta_description);
            pushDoc("customize_meta_description", p.customize_meta_description);
            pushDoc("contact_meta_description", p.contact_meta_description);
            pushDoc("rigidbox_meta_description", p.rigidbox_meta_description);
            pushDoc("cakebox_meta_description", p.cakebox_meta_description);
            pushDoc("cakebase_meta_description", p.cakebase_meta_description);
            
            if (pageDocs.length > 0) {
                await upsertDocuments(pageDocs);
                total += pageDocs.length;
            }
        }
    } catch (pageErr) {
        console.error("Auto-sync pages failed:", pageErr.message);
    }

    res.json({ ok: true, count: total, message: "Products and Pages synced to RAG" });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});

router.get("/rag/query", auth, async (req, res) => {
  try {
    const q = req.query.q || "";
    const topK = req.query.topK ? parseInt(req.query.topK) : 4;
    const result = await queryRag(q, topK);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});

router.post("/rag/upsert-from-pages", auth, async (req, res) => {
  try {
    const [pages] = await mysqlPool.query("SELECT * FROM `tbl_page` LIMIT 1");
    if (!pages || !pages.length) return res.json({ ok: true, count: 0 });
    const p = pages[0];
    const docs = [];
    function pushDoc(id, text) {
      if (text && String(text).trim().length > 0) {
        docs.push({ id, text: String(text), metadata: { source: "tbl_page" } });
      }
    }
    pushDoc("about_content", p.about_content);
    pushDoc("products_meta_description", p.products_meta_description);
    pushDoc("customize_meta_description", p.customize_meta_description);
    pushDoc("contact_meta_description", p.contact_meta_description);
    pushDoc("rigidbox_meta_description", p.rigidbox_meta_description);
    pushDoc("cakebox_meta_description", p.cakebox_meta_description);
    pushDoc("cakebase_meta_description", p.cakebase_meta_description);
    const result = await upsertDocuments(docs);
    res.json({ ok: true, count: docs.length, result });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});

router.get("/sql/products/composed", auth, async (req, res) => {
  try {
    const pId = req.query.p_id ? parseInt(req.query.p_id) : null;
    const ecatId = req.query.ecat_id ? parseInt(req.query.ecat_id) : null;
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const params = [];
    let sql = "SELECT * FROM `tbl_product`";
    const where = [];
    if (pId) {
      where.push("`p_id` = ?");
      params.push(pId);
    }
    if (ecatId) {
      where.push("`ecat_id` = ?");
      params.push(ecatId);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY `p_id` DESC";
    if (limit) sql += " LIMIT " + limit;
    const [products] = await mysqlPool.query(sql, params);
    if (!products || products.length === 0) {
      return res.json({ count: 0, rows: [] });
    }
    const ids = products.map((p) => p.p_id);
    const [photos] = await mysqlPool.query(
      "SELECT * FROM `tbl_product_photo` WHERE `p_id` IN (?)",
      [ids]
    );
    const [colors] = await mysqlPool.query(
      "SELECT pc.`p_id`, pc.`color_id`, c.`color_name`, pc.`id` FROM `tbl_product_color` pc JOIN `tbl_color` c ON pc.`color_id` = c.`color_id` WHERE pc.`p_id` IN (?)",
      [ids]
    );
    const [sizes] = await mysqlPool.query(
      "SELECT ps.`p_id`, ps.`size_id`, s.`size_name`, ps.`id` FROM `tbl_product_size` ps JOIN `tbl_size` s ON ps.`size_id` = s.`size_id` WHERE ps.`p_id` IN (?)",
      [ids]
    );
    const [quantities] = await mysqlPool.query(
      "SELECT pq.`p_id`, pq.`qty_id`, q.`qty_name`, q.`pack_size`, pq.`id` FROM `tbl_product_qty` pq JOIN `tbl_quantity` q ON pq.`qty_id` = q.`qty_id` WHERE pq.`p_id` IN (?)",
      [ids]
    );
    const [cats] = await mysqlPool.query(
      "SELECT p.`p_id`, ec.`ecat_id`, ec.`ecat_name`, mc.`mcat_id`, mc.`mcat_name`, tc.`tcat_id`, tc.`tcat_name` FROM `tbl_product` p LEFT JOIN `tbl_end_category` ec ON p.`ecat_id`=ec.`ecat_id` LEFT JOIN `tbl_mid_category` mc ON ec.`mcat_id`=mc.`mcat_id` LEFT JOIN `tbl_top_category` tc ON mc.`tcat_id`=tc.`tcat_id` WHERE p.`p_id` IN (?)",
      [ids]
    );
    const [ratings] = await mysqlPool.query(
      "SELECT * FROM `tbl_rating` WHERE `p_id` IN (?)",
      [ids]
    );
    const photoMap = {};
    for (const r of photos) {
      const k = r.p_id;
      if (!photoMap[k]) photoMap[k] = [];
      photoMap[k].push(r);
    }
    const colorMap = {};
    for (const r of colors) {
      const k = r.p_id;
      if (!colorMap[k]) colorMap[k] = [];
      colorMap[k].push(r);
    }
    const sizeMap = {};
    for (const r of sizes) {
      const k = r.p_id;
      if (!sizeMap[k]) sizeMap[k] = [];
      sizeMap[k].push(r);
    }
    const qtyMap = {};
    for (const r of quantities) {
      const k = r.p_id;
      if (!qtyMap[k]) qtyMap[k] = [];
      qtyMap[k].push(r);
    }
    const catMap = {};
    for (const r of cats) {
      catMap[r.p_id] = {
        ecat_id: r.ecat_id,
        ecat_name: r.ecat_name,
        mcat_id: r.mcat_id,
        mcat_name: r.mcat_name,
        tcat_id: r.tcat_id,
        tcat_name: r.tcat_name,
      };
    }
    const ratingMap = {};
    for (const r of ratings) {
      const k = r.p_id;
      if (!ratingMap[k]) ratingMap[k] = [];
      ratingMap[k].push(r);
    }
    const composed = products.map((p) => ({
      product: p,
      category: catMap[p.p_id] || null,
      photos: photoMap[p.p_id] || [],
      colors: colorMap[p.p_id] || [],
      sizes: sizeMap[p.p_id] || [],
      quantities: qtyMap[p.p_id] || [],
      ratings: ratingMap[p.p_id] || [],
    }));
    res.json({ count: composed.length, rows: composed });
  } catch (err) {
    res.status(500).json({ message: "Failed", error: err.message });
  }
});


// Bookings
router.get("/bookings", auth, async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/bookings/:id/sendMessage", auth, async (req, res) => {
  const { message } = req.body;
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    await sendWhatsApp(booking.whatsapp, message);
    res.json({ ok: true, message: "WhatsApp message sent successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to send WhatsApp message" });
  }
});

// Categories
router.get("/categories", auth, async (req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ name: 1 });
  res.json(categories);
});
router.post("/categories", auth, async (req, res) => {
  const { name, url, parentId, isActive } = req.body;
  const c = new Category({ name, url, parentId: parentId || null, isActive: isActive !== false });
  await c.save();
  res.json(c);
});
router.put("/categories/:id", auth, async (req, res) => {
  const { name, url, parentId, isActive } = req.body;
  const c = await Category.findByIdAndUpdate(
    req.params.id,
    { name, url, parentId: parentId || null, isActive },
    { new: true }
  );
  if (!c) return res.status(404).json({ message: "Category not found" });
  res.json(c);
});
router.delete("/categories/:id", auth, async (req, res) => {
  await Category.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Products
router.get("/products", auth, async (req, res) => {
  const { categoryId } = req.query;
  const filter = { isActive: true };
  if (categoryId) filter.categoryId = categoryId;
  const products = await Product.find(filter).sort({ createdAt: -1 });
  res.json(products);
});
router.post("/products", auth, async (req, res) => {
  const { name, description, price, imageUrl, url, categoryId, stock, isActive } = req.body;
  const p = new Product({ name, description, price, imageUrl, url, categoryId, stock, isActive: isActive !== false });
  await p.save();
  res.json(p);
});
router.put("/products/:id", auth, async (req, res) => {
  const { name, description, price, imageUrl, url, categoryId, stock, isActive } = req.body;
  const p = await Product.findByIdAndUpdate(
    req.params.id,
    { name, description, price, imageUrl, url, categoryId, stock, isActive },
    { new: true }
  );
  if (!p) return res.status(404).json({ message: "Product not found" });
  res.json(p);
});
router.delete("/products/:id", auth, async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Orders list
router.get("/orders", auth, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

// Import from SQL dump (categories, products, documents)
router.post("/import-sql", auth, async (req, res) => {
  try {
    const dumpPath = path.join(__dirname, "..", "u861980547_sachetan.sql");
    if (!fs.existsSync(dumpPath)) {
      return res.status(404).json({ message: "SQL dump not found" });
    }
    const sql = fs.readFileSync(dumpPath, "utf8");

    function extractBlocks(regex) {
      const matches = [];
      for (const m of sql.matchAll(regex)) {
        matches.push(m[1]);
      }
      return matches;
    }
    function splitRows(block) {
      return block
        .trim()
        .replace(/^\s*VALUES\s*/i, "")
        .replace(/;$/, "")
        .split(/\)\s*,\s*\(/)
        .map((r) => r.replace(/^\(/, "").replace(/\)$/, "").trim());
    }
    function parseRow(row) {
      const out = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === "'" && row[i - 1] !== "\\") {
          inQuote = !inQuote;
          cur += ch;
        } else if (ch === "," && !inQuote) {
          out.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      if (cur.length) out.push(cur.trim());
      return out.map((v) => (v === "NULL" ? null : v.replace(/^'|'+$/g, "")));
    }

    const topBlocks = extractBlocks(/INSERT INTO `tbl_top_category`[^]*?VALUES\s*([\s\S]*?);/gi);
    const midBlocks = extractBlocks(/INSERT INTO `tbl_mid_category`[^]*?VALUES\s*([\s\S]*?);/gi);
    const endBlocks = extractBlocks(/INSERT INTO `tbl_end_category`[^]*?VALUES\s*([\s\S]*?);/gi);
    const productBlocks = extractBlocks(/INSERT INTO `tbl_product`[^]*?VALUES\s*([\s\S]*?);/gi);

    const mapTop = {};
    const mapMid = {};
    const mapEnd = {};

    for (const block of topBlocks) {
      const rows = splitRows(block);
      for (const row of rows) {
        const [tcat_id, tcat_name] = parseRow(row);
        if (!tcat_name) continue;
        let existing = await Category.findOne({ name: tcat_name });
        if (!existing) {
          existing = await new Category({ name: tcat_name }).save();
        }
        mapTop[parseInt(tcat_id)] = existing._id;
      }
    }

    for (const block of midBlocks) {
      const rows = splitRows(block);
      for (const row of rows) {
        const [mcat_id, mcat_name, tcat_id] = parseRow(row);
        if (!mcat_name) continue;
        const parentId = mapTop[parseInt(tcat_id)];
        let existing = await Category.findOne({ name: mcat_name });
        if (!existing) {
          existing = await new Category({ name: mcat_name, parentId }).save();
        }
        mapMid[parseInt(mcat_id)] = existing._id;
      }
    }

    for (const block of endBlocks) {
      const rows = splitRows(block);
      for (const row of rows) {
        const [ecat_id, ecat_name, mcat_id] = parseRow(row);
        if (!ecat_name) continue;
        const parentId = mapMid[parseInt(mcat_id)];
        let existing = await Category.findOne({ name: ecat_name });
        if (!existing) {
          existing = await new Category({ name: ecat_name, parentId }).save();
        }
        mapEnd[parseInt(ecat_id)] = existing._id;
      }
    }

    let productCount = 0;
    for (const block of productBlocks) {
      const rows = splitRows(block);
      for (const row of rows) {
        const values = parseRow(row);
        const [
          p_id,
          p_name,
          p_old_price,
          p_current_price,
          p_qty,
          total_quantity,
          p_featured_photo,
          p_featured_photo_alt,
          p_description,
          p_feature,
          p_condition,
          p_return_policy,
          p_total_view,
          p_is_active,
          printbase,
          windowActive,
          pastelActive,
          printedboards,
          recommend_p,
          ecat_id,
        ] = values;
        if (!p_name) continue;
        const categoryId = mapEnd[parseInt(ecat_id)];
        const existing = await Product.findOne({ name: p_name });
        if (!existing) {
          await new Product({
            name: p_name,
            description: p_description || "",
            price: p_current_price ? parseFloat(p_current_price) : 0,
            imageUrl: p_featured_photo || "",
            url: "",
            categoryId,
            stock: total_quantity ? parseInt(total_quantity) : 0,
            isActive: p_is_active ? p_is_active === "1" : true,
          }).save();
          productCount++;
        }
      }
    }

    res.json({ ok: true, message: "Import completed", productsImported: productCount });
  } catch (err) {
    console.error("Import SQL failed:", err);
    res.status(500).json({ message: "Import failed", error: err.message });
  }
});

module.exports = router;
