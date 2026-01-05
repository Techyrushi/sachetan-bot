const cron = require("node-cron");
const Booking = require("../models/Booking");
const sendWhatsApp = require("./sendWhatsApp");
const mysqlPool = require("../config/mysql");
const { upsertDocuments } = require("./rag");

async function syncProducts() {
  try {
    console.log("Starting product sync...");
    const [products] = await mysqlPool.query(`
      SELECT 
        p.p_id, p.p_name, p.p_old_price, p.p_current_price, p.p_featured_photo, p.total_quantity, p.p_description,
        t.tcat_name, m.mcat_name, e.ecat_name
      FROM tbl_product p
      LEFT JOIN tbl_end_category e ON p.ecat_id = e.ecat_id
      LEFT JOIN tbl_mid_category m ON e.mcat_id = m.mcat_id
      LEFT JOIN tbl_top_category t ON m.tcat_id = t.tcat_id
      WHERE p.total_quantity > 0
    `);

    const docs = [];
    for (const pr of products || []) {
      // Construct rich text for RAG
      const price = pr.p_current_price || pr.p_old_price || "Contact for Price";
      const categoryPath = [pr.tcat_name, pr.mcat_name, pr.ecat_name].filter(Boolean).join(" > ");
      const imageUrl = pr.p_featured_photo
        ? `https://sachetanpackaging.in/assets/uploads/${pr.p_featured_photo}` 
        : "";

      let text = `Product: ${pr.p_name}\n`;
      text += `Category: ${categoryPath}\n`;
      text += `Price: ₹${price}\n`;
      text += `Description: ${pr.p_description || "No description available."}\n`;
      
      if (imageUrl) {
        text += `Image Available: ${imageUrl}\n`;
      }

      let type = "Homebakers";
      const catLower = (pr.tcat_name || "").toLowerCase();
      if (catLower.includes("store owner") || catLower.includes("bulk buyer")) type = "Store Owner/ Bulk Buyer";  
      else if (catLower.includes("sweet shop owner")) type = "Sweet Shop Owner";        

      // Metadata for filtering
      const metadata = {
        source: "tbl_product",
        type: type,
        price: String(price),
        category: categoryPath
      };

      docs.push({ 
        id: `product_${pr.p_id}`, 
        text, 
        metadata 
      });
    }

    if (docs.length) {
      console.log(`Upserting ${docs.length} products to Pinecone...`);
      await upsertDocuments(docs);
      console.log("Product sync complete.");
    } else {
      console.log("No products found to sync.");
    }

  } catch (e) {
    console.error("Product sync error:", e.message);
  }
}

function startCronJobs() {
  // Run product sync immediately on startup (Reset + Add)
  // Incremental: do not reset Pinecone; only upsert/append new data
  console.log("Initializing incremental Pinecone sync (no reset)...");
  syncProducts();

  // run every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    try {
      const now = new Date();
      const bookings = await Booking.find({ status: "confirmed" });
      for (const booking of bookings) {
        // slot expected like "06:00 - 07:00"; take start time
        const start = booking.slot ? booking.slot.split('-')[0].trim() : "00:00";
        const bookingDateTime = new Date(`${booking.date}T${start}:00`);
        const diffHrs = (bookingDateTime - now) / (1000 * 60 * 60);
        
        // 24-Hour Reminder
        if (Math.abs(diffHrs - 24) < 0.3 && !booking.reminded24h) {
          const qrCodeLink = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${booking._id}`;
          await sendWhatsApp(booking.whatsapp, 
`💿 Reminder: Your booking is tomorrow!

Booking ID: ${booking._id}
Date: ${booking.date}
Time: ${booking.slot}
Court: ${booking.courtName}
QR Code: ${qrCodeLink}

We look forward to seeing you!`);
          
          booking.reminded24h = true;
          await booking.save();
        }
        
        // 1-Hour Reminder
        if (Math.abs(diffHrs - 1) < 0.3 && !booking.reminded1h) {
          await sendWhatsApp(booking.whatsapp, 
`🌀 Reminder: Your pickleball booking starts in 1 hour.

Booking ID: ${booking._id}
Court: ${booking.courtName}
Time: ${booking.slot}
Contact info: +91-9876543210

Please arrive 10 minutes early for check-in.`);
          
          booking.reminded1h = true;
          await booking.save();
        }
      }
      
      // Clean up expired bookings (optional)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      // Update status of expired pending_payment bookings
      await Booking.updateMany(
        { 
          date: { $lt: yesterdayStr },
          status: "pending_payment"
        },
        {
          $set: { status: "expired" }
        }
      );
      
    } catch (err) {
      console.error("Cron job error:", err);
    }
  });

  cron.schedule("0 * * * *", async () => {
    try {
      // Sync Pages/Services (Keep existing logic)
      const [pages] = await mysqlPool.query("SELECT * FROM `tbl_page` LIMIT 1");
      const docs = [];
      if (pages && pages.length) {
        const p = pages[0];
        const fields = [
          ["about_content", p.about_content],
          ["products_meta_description", p.products_meta_description],
          ["customize_meta_description", p.customize_meta_description],
          ["contact_meta_description", p.contact_meta_description],
          ["rigidbox_meta_description", p.rigidbox_meta_description],
          ["cakebox_meta_description", p.cakebox_meta_description],
          ["cakebase_meta_description", p.cakebase_meta_description],
        ];
        for (const [id, text] of fields) {
          if (text && String(text).trim().length > 0) {
            docs.push({ id, text: String(text), metadata: { source: "tbl_page", type: "all" } });
          }
        }
      }
      const [services] = await mysqlPool.query("SELECT * FROM `tbl_service`");
      for (const s of services || []) {
        if (s.content) {
          docs.push({ id: `service_${s.id}`, text: String(s.content), metadata: { source: "tbl_service", title: s.title, type: "all" } });
        }
      }
      if (docs.length) {
        await upsertDocuments(docs);
      }
      
      // Sync Products (Incremental - no reset)
      await syncProducts();

    } catch (e) {
      console.error("RAG cron error:", e.message);
    }
  });

  // 7-Day Inactive User Reminder
  cron.schedule("0 10 * * *", async () => { // Runs daily at 10:00 AM
    try {
      // Find users inactive for > 7 days
      const [rows] = await mysqlPool.query(`
        SELECT phone FROM tbl_chat_sessions 
        WHERE last_message_at < DATE_SUB(NOW(), INTERVAL 7 DAY) 
        LIMIT 20
      `);

      if (rows.length > 0) {
        console.log(`Sending 7-day reminders to ${rows.length} users...`);
        for (const row of rows) {
          const { phone } = row;
          const reminderMsg = `👋 Hi there! It's been a while.\nAre you still looking for packaging solutions? 📦\n\nWe have new stock of Cake Boxes and Paper Bags!\nReply 'menu' to browse our latest collection or ask our AI assistant for help. 😊`;
          
          await sendWhatsApp(phone, reminderMsg);
          
          // Update timestamp to avoid re-sending immediately
          await mysqlPool.query("UPDATE tbl_chat_sessions SET last_message_at = NOW() WHERE phone = ?", [phone]);
          
          // Delay to respect rate limits
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch (err) {
      console.error("Vector upsert cron error:", err);
    }
  });

  // 7-day reminder
  cron.schedule("0 10 * * *", async () => {
    try {
      const [users] = await mysqlPool.query(
        "SELECT phone, stage FROM tbl_chat_sessions WHERE DATEDIFF(NOW(), last_message_at) = 7"
      );
      for (const user of users) {
        await sendWhatsApp(
          user.phone,
          `👋 Hi! It's been a while since we last chatted. 
          
Are you still looking for packaging solutions? 📦
We have new designs and offers!

Reply 'menu' to see our latest catalog or ask me anything!`
        );
      }
    } catch (err) {
      console.error("7-day reminder error:", err);
    }
  });
}

module.exports = startCronJobs;
