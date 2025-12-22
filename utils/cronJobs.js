const cron = require("node-cron");
const Booking = require("../models/Booking");
const sendWhatsApp = require("./sendWhatsApp");
const mysqlPool = require("../config/mysql");
const { upsertDocuments } = require("./rag");

function startCronJobs() {
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
            docs.push({ id, text: String(text), metadata: { source: "tbl_page" } });
          }
        }
      }
      const [services] = await mysqlPool.query("SELECT * FROM `tbl_service`");
      for (const s of services || []) {
        if (s.content) {
          docs.push({ id: `service_${s.id}`, text: String(s.content), metadata: { source: "tbl_service", title: s.title } });
        }
      }
      const [products] = await mysqlPool.query("SELECT `p_id`,`p_name`,`p_description` FROM `tbl_product` ORDER BY `p_total_view` DESC LIMIT 100");
      for (const pr of products || []) {
        const text = `${pr.p_name}\n${pr.p_description || ""}`;
        docs.push({ id: `product_${pr.p_id}`, text, metadata: { source: "tbl_product" } });
      }
      if (docs.length) {
        await upsertDocuments(docs);
      }
    } catch (e) {
      console.error("RAG cron error:", e.message);
    }
  });
}

module.exports = startCronJobs;
