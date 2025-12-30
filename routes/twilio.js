const express = require("express");
const Booking = require("../models/Booking");
const Slot = require("../models/Slot");
const Court = require("../models/Court");
const sendWhatsApp = require("../utils/sendWhatsApp");
const mysqlPool = require("../config/mysql");
const Category = require("../models/Category");
const Product = require("../models/Product");
const Order = require("../models/Order");
const { queryRag } = require("../utils/rag");
const { logConversation, logLead } = require("../utils/sheets");
// const { nanoid } = require("nanoid");
const cron = require("node-cron");

const router = express.Router();

// Helper function to get the latest counter from database
async function getLatestCounter(counterType) {
  try {
    // You can create a separate counters collection or use the bookings collection
    const latestBooking = await Booking.findOne().sort({ createdAt: -1 });

    if (!latestBooking) {
      return 0; // No bookings yet, start from 0
    }

    if (counterType === 'booking') {
      // Extract number from bookingId like "NP-01" -> 1
      const match = latestBooking.bookingId.match(/NP-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    } else if (counterType === 'invoice') {
      // Extract number from invoiceNumber like "NP-2025-01" -> 1
      const match = latestBooking.invoiceNumber.match(/NP-\d+-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }

    return 0;
  } catch (error) {
    console.error('Error getting latest counter:', error);
    return 0;
  }
}

// Add this helper function to split long messages
async function sendSplitMessage(phoneNumber, message, maxLength = 1500) {
  if (message.length <= maxLength) {
    await sendWhatsApp(phoneNumber, message);
    return;
  }

  // Split by double newlines first to preserve paragraphs
  const paragraphs = message.split('\n\n');
  let currentMessage = '';

  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed limit, send current message and start new one
    if ((currentMessage + paragraph + '\n\n').length > maxLength && currentMessage) {
      await sendWhatsApp(phoneNumber, currentMessage.trim());
      currentMessage = paragraph + '\n\n';
    } else {
      currentMessage += paragraph + '\n\n';
    }
  }

  // Send any remaining content
  if (currentMessage.trim()) {
    await sendWhatsApp(phoneNumber, currentMessage.trim());
  }
}

// Helper function to generate Booking ID (NP-01, NP-02, etc.)
async function generateBookingId() {
  const latestCounter = await getLatestCounter('booking');
  const nextCounter = latestCounter + 1;
  const id = `NP-${nextCounter.toString().padStart(2, '0')}`;
  return id;
}

// Helper function to generate Invoice Number (NP-2025-01, etc.)
async function generateInvoiceNumber() {
  const latestCounter = await getLatestCounter('invoice');
  const nextCounter = latestCounter + 1;
  const currentYear = new Date().getFullYear();
  const invoiceNo = `NP-${currentYear}-${nextCounter.toString().padStart(2, '0')}`;
  return invoiceNo;
}

// Helper function to generate available dates for next 7 days with day names
function getNextSevenDays() {
  const dates = [];
  const today = new Date();
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const formattedDate = date.toISOString().split("T")[0];
    const displayDate = `${date.getDate()} ${date.toLocaleString("default", {
      month: "short",
    })} ${days[date.getDay()]}`;
    const isPast = i === 0 && new Date().getHours() >= 22; // Consider past if after 10 PM today

    dates.push({
      value: formattedDate,
      display: displayDate,
      isPast: isPast || i < 0, // Disable past dates
    });
  }
  return dates;
}

// Helper function to calculate available players for a slot
async function getAvailablePlayersForSlot(date, slotTime, courtId) {
  const bookings = await Booking.find({
    date: date,
    slot: slotTime,
    courtId: courtId,
    status: { $in: ["confirmed", "pending_payment"] },
  });

  let bookedPlayers = 0;
  bookings.forEach((booking) => {
    bookedPlayers += booking.playerCount || 1; // Default to 1 if playerCount not set
  });

  return 4 - bookedPlayers; // Maximum 4 players per court
}

// Helper function to check if slot is available for players
async function isSlotAvailableForPlayers(
  date,
  slotTime,
  courtId,
  requiredPlayers
) {
  const availablePlayers = await getAvailablePlayersForSlot(
    date,
    slotTime,
    courtId
  );
  return availablePlayers >= requiredPlayers;
}

// Helper function to calculate amount based on duration and player count
function calculateAmount(duration, playerCount) {
  const pricePerPlayer = duration === "2 hours" ? 300 : 200;
  return pricePerPlayer * playerCount;
}

// Helper function to get duration from slot time
function getDurationFromSlot(slotTime) {
  // Assuming slot format like "7:00 AM - 8:00 AM" or "7:00 AM - 9:00 AM"
  const timeRange = slotTime.split(" - ");
  if (timeRange.length !== 2) return "1 hour";

  const startTime = new Date(`2000-01-01 ${timeRange[0]}`);
  const endTime = new Date(`2000-01-01 ${timeRange[1]}`);
  const durationHours = (endTime - startTime) / (1000 * 60 * 60);

  return durationHours === 2 ? "2 hours" : "1 hour";
}

// Helper to strip HTML tags
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
}

// Helper to check if input is likely conversational/question
function isConversational(text) {
  const t = text.toLowerCase();
  // If it's a number, it's likely a selection (unless it's a year or something, but context matters)
  if (/^\d+$/.test(t)) return false;

  // If it's short command like "yes", "no", "menu", "cancel"
  if (["yes", "no", "menu", "cancel", "confirm"].includes(t)) return false;

  // Otherwise, assume it's conversational
  return true;
}

// Helper function to parse time and check 2-hour buffer
function isTimeSlotAvailable(slotTime, selectedDate) {
  try {
    const currentDate = new Date();
    const bookingDate = new Date(selectedDate);

    // If booking is for future date, it's available
    if (bookingDate > currentDate) {
      return true;
    }

    // If booking is for today, check 2-hour buffer
    if (bookingDate.toDateString() === currentDate.toDateString()) {
      const timeParts = slotTime.split("-");
      if (timeParts.length < 2) return true;

      const startTimeStr = timeParts[0].trim();
      let timeStr = startTimeStr.replace(".", ":");

      const isPM = timeStr.toLowerCase().includes("pm");
      const isAM = timeStr.toLowerCase().includes("am");

      timeStr = timeStr.replace(/am|pm/i, "").trim();
      const [hours, minutes] = timeStr.split(":").map(Number);

      let adjustedHours = hours;
      if (isPM && hours < 12) adjustedHours += 12;
      if (isAM && hours === 12) adjustedHours = 0;

      const slotStartTime = new Date(currentDate);
      slotStartTime.setHours(adjustedHours, minutes, 0, 0);

      const bufferTime = new Date(currentDate);
      bufferTime.setHours(bufferTime.getHours() + 2);

      return slotStartTime > bufferTime;
    }

    return false;
  } catch (error) {
    console.error(`Error parsing time for slot ${slotTime}:`, error);
    return false;
  }
}

cron.schedule("* * * * *", async () => {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const expiredBookings = await Booking.find({
    status: "pending_payment",
    createdAt: { $lte: fiveMinutesAgo },
  });

  for (const booking of expiredBookings) {
    booking.status = "expired";
    await booking.save();

    await sendWhatsApp(
      booking.whatsapp,
      `❌ *Payment Link Expired*\n\nYour payment link for booking ${booking.bookingId} has expired. Please book again to confirm your slot.\n\nReply 'menu' to return to main menu.`
    );
  }
});

// Payment link creation
function createPaymentLink(bookingId) {
  const baseUrl = process.env.BASE_URL || "http://localhost:4000";
  return `${baseUrl}/payment?booking=${bookingId}`;
}


router.post("/", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim().toLowerCase();

    const userName = from.split("+")[1] || "there";

    router.sessions = router.sessions || {};
    const sessions = router.sessions;

    // Handle initial greeting or restart
    if (
      body === "hi" ||
      body === "hello" ||
      body === "hey" ||
      body === "hii" ||
      body === "hiii" ||
      body === "hola" ||
      body === "restart" ||
      body === "start" ||
      body === "begin" ||
      body === "menu" ||
      body === "main menu" ||
      body === "back" ||
      body === "home" ||
      body === "exit" ||
      body === "end" ||
      body === "stop" ||
      body === "reset" ||
      body === "thanks" ||
      body === "thank you" ||
      body === "thankyou" ||
      body === "thx" ||
      body === "ty" ||
      body === "thank u" ||
      body === "ok" ||
      body === "okay" ||
      body === "cool" ||
      body === "done" ||
      body === "confirmed" ||
      body === "yes" ||
      body === "yep" ||
      body === "yo" ||
      body === "good morning" ||
      body === "good evening" ||
      body === "good night" ||
      body === "Thank you for confirming my booking." ||
      body.includes(["Hi", "Thank you"])
    ) {
      delete sessions[from];
      sessions[from] = { stage: "menu" };
      const logoUrl = `${"https://sachetanpackaging.in"}/assets/uploads/logo.png`;

      await sendWhatsApp(from, "", { mediaUrl: logoUrl });
      await new Promise(r => setTimeout(r, 5000)); // Wait 1.5s for media to arrive first
      await sendWhatsApp(
        from,
        `🌟 *Welcome to Sachetan Packaging*
_Quality Packaging Solutions Since 2011_

We are a premier organization engaged in manufacturing and supplying a wide assortment of:
🎂 *Cake & Brownie Boxes*
🍰 *Pastry Boxes*
🧁 *Cup Cake Boxes*
🥡 *Laminated Boxes & Bases*
📦 *Customized Boxes & Bases*

🌐 *Visit us:* https://sachetanpackaging.in

──────────────────

👇 *Please select a service:*

*1️⃣ Buy Products* - Browse catalog & order
*2️⃣ Order Status* - Track your shipment
*3️⃣ AI Assistant* - Product Queries
*4️⃣ FAQ & Support* - Contact Us

        _Reply with a number to proceed._`,
        { contentSid: process.env.TWILIO_CONTENT_SID_SERVICES }
      );
      return res.end();
    }

    if (!sessions[from]) {
      sessions[from] = { stage: "menu" };
      const logoUrl = `${"https://sachetanpackaging.in"}/assets/uploads/logo.png`;
      await sendWhatsApp(from, "", { mediaUrl: logoUrl });
      await new Promise(r => setTimeout(r, 5000)); // Wait 5s for media to arrive first 
      await sendWhatsApp(
        from,
        `🌟 *Welcome to Sachetan Packaging*
_Quality Packaging Solutions Since 2011_

We are a premier organization engaged in manufacturing and supplying a wide assortment of:
🎂 *Cake & Brownie Boxes*
🍰 *Pastry Boxes*
🧁 *Cup Cake Boxes*
🥡 *Laminated Boxes & Bases*
📦 *Customized Boxes & Bases*

🌐 *Visit us:* https://sachetanpackaging.in

──────────────────

👇 *Please select a service:*

*1️⃣ Buy Products* - Browse catalog & order
*2️⃣ Order Status* - Track your shipment
*3️⃣ AI Assistant* - Product Queries
*4️⃣ FAQ & Support* - Contact Us

        _Reply with a number to proceed._`,
        { contentSid: process.env.TWILIO_CONTENT_SID_SERVICES }
      );
      return res.end();
    }

    const session = sessions[from];

    if (session.stage === "menu") {
      if (body === "1" || body.includes("buy") || body.includes("product")) {
        session.stage = "shop_top_category";
        const [topCats] = await mysqlPool.query("SELECT `tcat_id`,`tcat_name` FROM `tbl_top_category` ORDER BY `tcat_name` ASC");
        if (!topCats.length) {
          await sendWhatsApp(from, "No categories available. Please try again later.");
          return res.end();
        }
        session.topCats = topCats;
        let msg = "🛒 *Select a Top Category:*\n\n";
        topCats.forEach((c, i) => { msg += `*${i + 1}️⃣ ${c.tcat_name}*\n`; });
        msg += "\nReply with the number.";
        await sendWhatsApp(from, msg);
        return res.end();
      } else if (body === "2" || body.includes("order status") || body.includes("status")) {
        session.stage = "order_status";
        await sendWhatsApp(from, "Please reply with your Order ID.");
        return res.end();
      } else if (body === "3" || body.includes("assistant") || body.includes("faq")) {
        session.stage = "ai_assistant";
        await sendWhatsApp(
          from,
          `👋 Hi! Welcome to *Sachetan Packaging* 😊

Thank you for reaching out. I’m here to help you find the right packaging for your product.

You can share:

📦 What product you need packaging for (cake box, cake base, paper bag, etc.)
📏 Size or usage (for example: 1 kg cake)
🎨 Whether you need plain or printed boxes
🔢 Approximate quantity

Even if you’re not sure about all the details, that’s absolutely fine — just tell me what you know, and I’ll guide you step by step to the best option.

How can I assist you today?`
        );
        return res.end();
      } else if (body === "4" || body.includes("support")) {
        await sendWhatsApp(from, `🏢 *Contact & Support*

📍 *Address:*
Plot No. J30, Near Jai Malhar Hotel, 
MIDC, Sinnar 422106

📞 *Phone:*
• +91 92263 22231
• +91 84460 22231

📧 *Email:*
sagar9994@rediffmail.com

🌐 *Website:*
https://sachetanpackaging.in

Reply 'menu' to return to main menu.`);
        return res.end();
      } else if (body.includes("book") || body.includes("court")) {
        session.stage = "choose_date";
        const availableDates = getNextSevenDays();
        let dateOptions = "🗓️ *Select a Booking Date:*\n\n";
        availableDates.forEach((date, i) => {
          if (!date.isPast) {
            dateOptions += `*${i + 1}️⃣ ${date.display}*\n`;
          }
        });
        dateOptions += "\nReply with the date number.";
        session.availableDates = availableDates;
        await sendWhatsApp(from, dateOptions);
        return res.end();
      } else if (body === "my bookings") {
        const bookings = await Booking.find({ whatsapp: from });
        if (!bookings.length) {
          await sendWhatsApp(
            from,
            "📭 *You have no bookings.*\n\nReply with 'menu' to return to main menu."
          );
        } else {
          let text = "📚 *Your Bookings:*\n\n";
          bookings.forEach((b, i) => {
            text += `*Booking #${i + 1}*\n`;
            text += `🆔 ID: ${b.bookingId}\n`;
            text += `📅 Date: ${b.date}\n`;
            text += `⏰ Time: ${b.slot}\n`;
            text += `⏱️ Duration: ${b.duration}\n`;
            text += `🎾 Court: ${b.courtName}\n`;
            text += `👥 Players: ${b.playerCount || 1}\n`;
            text += `💰 Amount: ₹${b.amount}\n`;
            text += `📊 Status: ${b.status}\n\n`;
          });
          text += "Reply with 'menu' to return to main menu.";
          await sendWhatsApp(from, text);
        }
        return res.end();
      } else if (body.includes("availability")) {
        session.stage = "check_availability_date";
        const availableDates = getNextSevenDays();
        let dateOptions = "🔍 *Check Availability For:*\n\n";
        availableDates.forEach((date, i) => {
          if (!date.isPast) {
            dateOptions += `*${i + 1}️⃣ ${date.display}*\n`;
          }
        });
        dateOptions += "\nReply with the date number.";
        session.availableDates = availableDates;
        await sendWhatsApp(from, dateOptions);
        return res.end();
      } else if (body.includes("pricing") || body.includes("rules")) {
        let pricingInfo = `💰 *NashikPicklers Pricing & Rules*\n\n*Court Pricing (per player):*\n`;
        pricingInfo += `• 1 hour session: ₹200 per player\n`;
        pricingInfo += `• 2 hours session: ₹300 per player\n`;

        pricingInfo += `\n*Example Calculations:*\n`;
        pricingInfo += `• 2 players for 1 hour: ₹400\n`;
        pricingInfo += `• 3 players for 1 hour: ₹600\n`;
        pricingInfo += `• 4 players for 1 hour: ₹800\n`;
        pricingInfo += `• 2 players for 2 hours: ₹600\n`;
        pricingInfo += `• 3 players for 2 hours: ₹900\n`;
        pricingInfo += `• 4 players for 2 hours: ₹1200\n\n`;

        pricingInfo += `⏰ *Business Hours:*\n`;
        pricingInfo += `• 7:00 AM to 10:00 PM\n\n`;

        pricingInfo += `⚠️ *Booking Rules:*
• Bookings must be made at least 2 hours in advance
• Minimum 2 players required per booking
• Maximum 4 players per court
• Cancellations with full refund allowed up to 24 hours before
• Late cancellations incur a 50% fee
• Please arrive 10 minutes before your slot

Reply with 'menu' to return to main menu.`;

        await sendWhatsApp(from, pricingInfo);
        return res.end();
      } else if (body.includes("contact") || body.includes("admin")) {
        await sendWhatsApp(
          from,
          `📞 *Contact NashikPicklers Admin*

For urgent matters:
📱 Call: +91-8862084297

For general inquiries:
📧 Email: nashikpicklers@gmail.com

📍 Location: https://maps.app.goo.gl/GmZp2m2pMo3LFGJy9?g_st=awb

⏰ *Operating Hours:*
Monday-Friday: 9:00 AM - 6:00 PM
Weekends: 10:00 AM - 4:00 PM

Reply with 'menu' to return to main menu.`
        );
        return res.end();
      } else if (body === "hi" ||
        body === "hello" ||
        body === "hey" ||
        body === "hii" ||
        body === "hiii" ||
        body === "hola" ||
        body === "restart" ||
        body === "start" ||
        body === "begin" ||
        body === "menu" ||
        body === "main menu" ||
        body === "back" ||
        body === "home" ||
        body === "exit" ||
        body === "end" ||
        body === "stop" ||
        body === "reset" ||
        body === "thanks" ||
        body === "thank you" ||
        body === "thankyou" ||
        body === "thx" ||
        body === "ty" ||
        body === "thank u" ||
        body === "ok" ||
        body === "okay" ||
        body === "cool" ||
        body === "done" ||
        body === "confirmed" ||
        body === "yes" ||
        body === "yep" ||
        body === "yo" ||
        body === "good morning" ||
        body === "good evening" ||
        body === "good night" ||
        body === "Thank you for confirming my booking." ||
        body.includes(["Hi", "Thank you"])
      ) {
        await sendWhatsApp(
          from,
          `🧰 *Sachetan Packaging*

*1️⃣ Buy Products* - Browse categories and order
*2️⃣ Order Status* - Track your order
*3️⃣ AI Assistant* - Ask product FAQs
*4️⃣ FAQ & Support* - Help and contact

Reply with a number or option name.`
        );
        return res.end();
      } else {
        // Fallback to AI for any text that isn't a menu command
        try {
          const result = await queryRag(body);
          await sendWhatsApp(from, result.answer || "I'm not sure about that. Reply 'menu' to see options.");

          // Optional: save to memory
          try {
            const { upsertDocuments } = require("../utils/rag");
            await upsertDocuments([
              { id: `q_${Date.now()}`, text: `Q: ${body}\nA: ${result.answer || ""}`, metadata: { source: "chat", user: from } }
            ], "customer_memory");
          } catch { }

        } catch (e) {
          await sendWhatsApp(
            from,
            "❌ Invalid selection. Reply 'menu' to see options."
          );
        }
        return res.end();
      }
    }

    // Handle Exit Flow Confirmation
    if (session.stage === "confirm_exit_flow") {
      if (body === "1" || body.toLowerCase() === "yes") {
        // User wants to exit flow and ask AI
        session.stage = "ai_assistant";
        // We can treat the pending question as the input for AI immediately
        const question = session.pendingQuestion;
        delete session.pendingQuestion;
        delete session.previousStage;

        // Process AI request immediately
        try {
          const result = await queryRag(question);
          await sendWhatsApp(from, result.answer || "No answer available right now.");
          try {
            const { upsertDocuments } = require("../utils/rag");
            await upsertDocuments([
              { id: `q_${Date.now()}`, text: `Q: ${question}\nA: ${result.answer || ""}`, metadata: { source: "chat", user: from } }
            ], "customer_memory");
          } catch { }
        } catch (e) {
          await sendWhatsApp(from, "⚠️ Oops! Our assistant is taking a short break. Please try again in a few moments - we’ll be right back to help you 😊");
        }
        return res.end();

      } else {
        // User wants to stay in flow
        session.stage = session.previousStage;
        delete session.pendingQuestion;
        delete session.previousStage;
        await sendWhatsApp(from, "Okay, continuing with your order. Please make a selection.");
        // Ideally we should re-send the options here, but for now just asking for selection is enough or user can scroll up
        return res.end();
      }
    }

    // Product shopping stages
    if (session.stage === "shop_top_category") {
      const idx = parseInt(body);
      const cats = session.topCats || [];
      if (isNaN(idx) || idx < 1 || idx > cats.length) {
        if (isConversational(body)) {
          session.previousStage = session.stage;
          session.pendingQuestion = body;
          session.stage = "confirm_exit_flow";
          await sendWhatsApp(from, `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`, {
            buttons: [
              { id: 'yes', text: 'Yes, ask AI' },
              { id: 'no', text: 'No, continue order' }
            ]
          });
          return res.end();
        }
        await sendWhatsApp(from, "Invalid selection. Reply with the category number.");
        return res.end();
      }
      const selectedTop = cats[idx - 1];
      session.selectedTop = selectedTop;
      const [midCats] = await mysqlPool.query("SELECT `mcat_id`,`mcat_name` FROM `tbl_mid_category` WHERE `tcat_id`=? ORDER BY `mcat_name` ASC", [selectedTop.tcat_id]);
      if (!midCats.length) {
        await sendWhatsApp(from, "No subcategories in this category. Reply 'menu' to go back.");
        session.stage = "menu";
        return res.end();
      }
      session.midCats = midCats;
      session.stage = "shop_mid_category";
      let msg = `📂 *${selectedTop.tcat_name}*\n\nSelect a subcategory:\n\n`;
      midCats.forEach((c, i) => { msg += `*${i + 1}️⃣ ${c.mcat_name}*\n`; });
      msg += "\nReply with the number.";
      await sendWhatsApp(from, msg);
      return res.end();
    }

    if (session.stage === "shop_mid_category") {
      const idx = parseInt(body);
      const cats = session.midCats || [];
      if (isNaN(idx) || idx < 1 || idx > cats.length) {
        if (isConversational(body)) {
          session.previousStage = session.stage;
          session.pendingQuestion = body;
          session.stage = "confirm_exit_flow";
          await sendWhatsApp(from, `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`, {
            buttons: [
              { id: 'yes', text: 'Yes, ask AI' },
              { id: 'no', text: 'No, continue order' }
            ]
          });
          return res.end();
        }
        await sendWhatsApp(from, "Invalid selection. Reply with the subcategory number.");
        return res.end();
      }
      const selectedMid = cats[idx - 1];
      session.selectedMid = selectedMid;

      // Direct Product Fetch (Skipping End Category)
      const [products] = await mysqlPool.query(`
        SELECT p.p_id, p.p_name, p.p_current_price, p.p_old_price, p.p_description, p.p_featured_photo 
        FROM tbl_product p
        JOIN tbl_end_category ec ON p.ecat_id = ec.ecat_id
        WHERE ec.mcat_id = ?
        ORDER BY p.p_name ASC
      `, [selectedMid.mcat_id]);

      if (!products.length) {
        await sendWhatsApp(from, "No products in this category. Reply 'menu' to go back.");
        session.stage = "menu";
        return res.end();
      }

      session.products = products;
      session.stage = "shop_product";
      let msg = `📦 *${selectedMid.mcat_name}*\n\nSelect a product:\n\n`;
      products.forEach((p, i) => {
        const price = p.p_current_price;
        const old = p.p_old_price > price ? ` ~₹${p.p_old_price}~` : "";
        msg += `*${i + 1}️⃣ ${p.p_name}* - ₹${price}${old}\n`;
      });
      msg += "\nReply with the product number, or 'menu' to go back.";
      await sendWhatsApp(from, msg);
      return res.end();
    }

    /* 
    // Skipped End Category Stage
    if (session.stage === "shop_end_category") {
       ...
    } 
    */

    if (session.stage === "shop_product") {
      const idx = parseInt(body);
      const products = session.products || [];
      if (isNaN(idx) || idx < 1 || idx > products.length) {
        if (isConversational(body)) {
          session.previousStage = session.stage;
          session.pendingQuestion = body;
          session.stage = "confirm_exit_flow";
          await sendWhatsApp(from, `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`, {
            buttons: [
              { id: 'yes', text: 'Yes, ask AI' },
              { id: 'no', text: 'No, continue order' }
            ]
          });
          return res.end();
        }
        await sendWhatsApp(from, "Invalid selection. Reply with the product number, or 'menu' to go back.");
        return res.end();
      }
      const product = products[idx - 1];
      session.selectedProduct = product;

      // Fetch extra details (sizes, colors)
      const [sizes] = await mysqlPool.query("SELECT s.size_name FROM tbl_size s JOIN tbl_product_size ps ON s.size_id=ps.size_id WHERE ps.p_id=?", [product.p_id]);
      const [colors] = await mysqlPool.query("SELECT c.color_name FROM tbl_color c JOIN tbl_product_color pc ON c.color_id=pc.color_id WHERE pc.p_id=?", [product.p_id]);

      product.sizes = sizes.map(s => s.size_name).join(", ");
      product.colors = colors.map(c => c.color_name).join(", ");

      session.stage = "shop_quantity";

      const oldPriceDisplay = product.p_old_price > product.p_current_price ? `\n❌ Old Price: ~₹${product.p_old_price}~` : "";
      const sizeDisplay = product.sizes ? `\n📏 Size: ${product.sizes}` : "";
      const colorDisplay = product.colors ? `\n🎨 Color: ${product.colors}` : "";

      const cleanDesc = stripHtml(product.p_description);
      const descDisplay = cleanDesc ? `\n📝 Description: ${cleanDesc.substring(0, 150)}${cleanDesc.length > 150 ? "..." : ""}` : "";

      const imageUrl = product.p_featured_photo
        ? `https://www.sachetanpackaging.in/assets/uploads/${product.p_featured_photo}`
        : null;

      await sendWhatsApp(from,
        `📦 *${product.p_name}*
──────────────────
💰 *Price: ₹${product.p_current_price}*${oldPriceDisplay}${sizeDisplay}${colorDisplay}${descDisplay}

👉 *Reply with Quantity* (e.g., 10) to proceed.
_Reply 'menu' to go back._`,
        imageUrl ? { mediaUrl: imageUrl } : {}
      );
      return res.end();
    }

    if (session.stage === "shop_quantity") {
      const qty = parseInt(body);
      if (isNaN(qty) || qty < 1) {
        if (isConversational(body)) {
          session.previousStage = session.stage;
          session.pendingQuestion = body;
          session.stage = "confirm_exit_flow";
          await sendWhatsApp(from, `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`, {
            buttons: [
              { id: 'yes', text: 'Yes, ask AI' },
              { id: 'no', text: 'No, continue order' }
            ]
          });
          return res.end();
        }
        await sendWhatsApp(from, "Invalid quantity. Please enter a positive number.");
        return res.end();
      }
      const product = session.selectedProduct;
      const total = (product.p_current_price || 0) * qty;

      // Prepare item with full details
      const item = {
        productId: product.p_id,
        name: product.p_name,
        price: product.p_current_price,
        quantity: qty,
        total,
        oldPrice: product.p_old_price,
        size: product.sizes,   // String like "Small, Medium"
        color: product.colors, // String like "Red, Blue"
        // dimensions/weight if available in product object
      };

      session.orderDraft = {
        items: [item],
        totalAmount: total,
      };

      // Ask for Customer Details
      session.stage = "ask_name";
      await sendWhatsApp(from, "👤 *Please enter your Full Name:*");
      return res.end();
    }

    if (session.stage === "ask_name") {
      if (isConversational(body)) {
        // Handle interruption if needed, but for name, almost anything is valid.
        // However, if they type "menu" or "cancel", it's handled by generic logic if we had it, 
        // but here we check specifically.
        if (body.toLowerCase() === "menu" ||
          body.toLowerCase() === "cancel" ||
          body.toLowerCase() === "exit" ||
          body.toLowerCase() === "stop" ||
          body.toLowerCase() === "reset" ||
          body.toLowerCase() === "back" ||
          body.toLowerCase() === "home" ||
          body.toLowerCase() === "exit" ||
          body.toLowerCase() === "end" ||
          body.toLowerCase() === "stop" ||
          body.toLowerCase() === "reset" ||
          body.toLowerCase() === "thanks" ||
          body.toLowerCase() === "thank you" ||
          body.toLowerCase() === "thankyou" ||
          body.toLowerCase() === "thx" ||
          body.toLowerCase() === "ty" ||
          body.toLowerCase() === "thank u" ||
          body.toLowerCase() === "ok" ||
          body.toLowerCase() === "okay" ||
          body.toLowerCase() === "cool" ||
          body.toLowerCase() === "done" ||
          body.toLowerCase() === "confirmed" ||
          body.toLowerCase() === "yes" ||
          body.toLowerCase() === "yep" ||
          body.toLowerCase() === "yo" ||
          body.toLowerCase() === "good morning" ||
          body.toLowerCase() === "good evening" ||
          body.toLowerCase() === "good night" ||
          body.toLowerCase() === "Thank you for confirming my booking.") {
          session.stage = "menu";
          await sendWhatsApp(from, "Order cancelled. Reply 'menu' to see options.");
          return res.end();
        }
      }

      session.orderDraft.customerName = body;
      session.stage = "ask_address";
      await sendWhatsApp(from, "📍 *Please enter your Delivery Address:*");
      return res.end();
    }

    if (session.stage === "ask_address") {
      session.orderDraft.address = body;
      session.stage = "ask_pincode";
      await sendWhatsApp(from, "📮 *Please enter your Pincode:*");
      return res.end();
    }

    if (session.stage === "ask_pincode") {
      session.orderDraft.pincode = body;
      session.stage = "shop_confirm";

      const draft = session.orderDraft;
      const item = draft.items[0]; // Currently single item flow

      await sendWhatsApp(
        from,
        `🧾 *Order Summary*
        
• *${item.name}*
  Qty: ${item.quantity}
  Price: ₹${item.price}
  Total: ₹${item.total}
  ${item.size ? `Size: ${item.size}` : ''}
  ${item.color ? `Color: ${item.color}` : ''}

*Customer Details:*
👤 Name: ${draft.customerName}
📍 Address: ${draft.address}
📮 Pincode: ${draft.pincode}

*Grand Total: ₹${draft.totalAmount}*`,
        {
          buttons: [
            { id: 'confirm', text: 'Confirm Order' },
            { id: 'menu', text: 'Cancel Order' }
          ],
          contentSid: process.env.TWILIO_CONTENT_SID_CONFIRM,
          contentVariables: {
            "1": item.name,
            "2": String(item.quantity),
            "3": String(item.price),
            "4": String(item.total),
            "5": item.size ? `Size: ${item.size}` : "",
            "6": item.color ? `Color: ${item.color}` : "",
            "7": draft.customerName,
            "8": draft.address,
            "9": draft.pincode,
            "10": String(draft.totalAmount)
          }
        }
      );
      return res.end();
    }

    if (session.stage === "shop_confirm") {
      if (body === "1" || body === "confirm" || body.includes("confirm")) {
        const draft = session.orderDraft;
        const orderId = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;
        const order = new Order({
          orderId,
          whatsapp: from,
          items: draft.items,
          totalAmount: draft.totalAmount,
          customerName: draft.customerName,
          address: draft.address,
          pincode: draft.pincode,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
        });
        await order.save();
        const payUrl = `${process.env.BASE_URL || "http://localhost:4000"}/payment/product?order=${order._id}`;
        await sendWhatsApp(from, `💳 *Payment Link Generated*
Order ID: ${orderId}
Amount: ₹${draft.totalAmount}

Click to pay:
${payUrl}

_Link expires in 5 minutes._
Reply 'menu' to return.`, {
          buttons: [
            { id: 'menu', text: 'Main Menu' }
          ],
          // Use 'used contentsid main menu button' (assuming placeholder or same SID if applicable, but usually distinct)
          // Since no explicit SID provided for Payment Link, we use a placeholder or reuse if appropriate.
          // Based on user input "used contentsid main menu button", we'll assume they want to use a specific SID they provided before 
          // or they mean the "Main Menu" SID is NOT for this. 
          // Actually, "used contentsid main menu button" likely refers to the Main Menu SID 'HX7d5236227e75996966c466fb55ef1434' 
          // but that template probably doesn't have 4 variables and a CTA.
          // We will use a placeholder process.env.TWILIO_CONTENT_SID_PAYMENT
          contentSid: process.env.TWILIO_CONTENT_SID_PAYMENT,
          contentVariables: {
            "1": orderId,
            "2": String(draft.totalAmount),
            "3": "5", // Expiration minutes
            "4": order._id.toString() // Dynamic part of the URL
          }
        });
        session.stage = "menu";
        try {
          const { upsertDocuments } = require("../utils/rag");
          await upsertDocuments([
            { id: `order_${order._id}`, text: `Order created: ${JSON.stringify(order.toObject())}`, metadata: { source: "order", user: from } }
          ], "customer_memory");
        } catch { }
        return res.end();
      } else if (body === "menu" ||
        body === "cancel" ||
        body === "exit" ||
        body === "stop" ||
        body === "reset" ||
        body === "back" ||
        body === "home" ||
        body === "exit" ||
        body === "end" ||
        body === "stop" ||
        body === "reset" ||
        body === "thanks" ||
        body === "thank you" ||
        body === "thankyou" ||
        body === "thx" ||
        body === "ty" ||
        body === "thank u" ||
        body === "ok" ||
        body === "okay" ||
        body === "cool" ||
        body === "done" ||
        body === "confirmed" ||
        body === "yes" ||
        body === "yep" ||
        body === "yo" ||
        body === "good morning" ||
        body === "good evening" ||
        body === "good night") {
        session.stage = "menu";
        await sendWhatsApp(from, "Order cancelled. Reply 'menu' to see options.");
        return res.end();
      } else {
        await sendWhatsApp(from, "Reply 'confirm' to proceed or 'menu' to cancel.");
        return res.end();
      }
    }

    if (session.stage === "order_status") {
      const id = body;
      try {
        const order = await Order.findById(id);
        if (!order) {
          await sendWhatsApp(from, "Order not found. Ensure you provided the correct Order ID.");
        } else {
          await sendWhatsApp(from, `📦 *Order Status*\n\nID: ${order._id}\nStatus: ${order.status}\nTotal: ₹${order.totalAmount}\n\nReply 'menu' to return.`);
        }
      } catch (e) {
        await sendWhatsApp(from, "Invalid Order ID format. Reply with the correct ID or 'menu' to go back.");
      }
      session.stage = "menu";
      return res.end();
    }

    if (session.stage === "ai_assistant") {
      const question = (req.body.Body || "").trim();
      session.sales = session.sales || { askedNameCity: false };
      function extractSpecs(t) {
        const s = t.toLowerCase();
        let product = "";
        if (/cake box|cakebox|cake\s*box/.test(s)) product = "Cake Box";
        else if (/pizza box|pizza\s*box/.test(s)) product = "Pizza Box";
        else if (/paper bag|bag/.test(s)) product = "Paper Bag";
        else if (/base|cake base|board/.test(s)) product = "Base";
        else if (/laminated box/.test(s)) product = "Laminated Box";
        const sizeMatch = s.match(/(\d+)\s*kg/) || s.match(/size\s*[:\-]\s*([^\n]+)/);
        const size = sizeMatch ? (sizeMatch[1] || sizeMatch[0]) : "";
        const qtyMatch = s.match(/(\d{2,})\s*(qty|pcs|pieces|quantity)/) || s.match(/quantity\s*[:\-]\s*(\d{2,})/);
        const quantity = qtyMatch ? (qtyMatch[1] || "") : "";
        const gsmMatch = s.match(/(\d{2,4})\s*gsm/);
        const paper = gsmMatch ? `${gsmMatch[1]} GSM` : "";
        const printing = /print|printed|logo|branding|custom/.test(s) ? "Yes" : "";
        return { product, size, paper, quantity, printing };
      }
      function extractNameCity(t) {
        const s = t.trim();
        let name = null, city = null;
        const m1 = s.match(/my name is\s+([a-zA-Z ]{2,})/i);
        if (m1) name = m1[1].trim();
        const m2 = s.match(/i am\s+([a-zA-Z ]{2,})/i);
        if (!name && m2) name = m2[1].trim();
        const m3 = s.match(/\bfrom\s+([a-zA-Z ]{2,})/i);
        if (m3) city = m3[1].trim();
        const m4 = s.match(/\bcity\s*[:\-]\s*([a-zA-Z ]{2,})/i);
        if (!city && m4) city = m4[1].trim();
        return { name, city };
      }
      const nc = extractNameCity(question);
      if (nc.name) session.sales.name = nc.name;
      if (nc.city) session.sales.city = nc.city;

      // Exit command
      if (question.toLowerCase() === "main menu" || question.toLowerCase() === "exit" || question.toLowerCase() === "menu" || question.toLowerCase() === "back" || question.toLowerCase() === "home" || question.toLowerCase() === "exit" || question.toLowerCase() === "end" || question.toLowerCase() === "stop" || question.toLowerCase() === "reset" || question.toLowerCase() === "thanks" || question.toLowerCase() === "thank you" || question.toLowerCase() === "thankyou" || question.toLowerCase() === "thx" || question.toLowerCase() === "ty" || question.toLowerCase() === "thank u" || question.toLowerCase() === "ok" || question.toLowerCase() === "okay" || question.toLowerCase() === "cool" || question.toLowerCase() === "done" || question.toLowerCase() === "confirmed" || question.toLowerCase() === "yes" || question.toLowerCase() === "yep" || question.toLowerCase() === "yo" || question.toLowerCase() === "good morning" || question.toLowerCase() === "good evening" || question.toLowerCase() === "good night") {
        session.stage = "menu";
        await sendWhatsApp(
          from,
          `🧰 *Sachetan Packaging*
          
*1️⃣ Buy Products*
*2️⃣ Order Status*
*3️⃣ AI Assistant*
*4️⃣ FAQ & Support*

Reply with a number.`
        );
        return res.end();
      }

      try {
        const result = await queryRag(question);
        const reply = result.answer || "No answer available right now.";
        await sendWhatsApp(from, reply);
        await logConversation({
          phone: from,
          name: session.sales.name || "",
          city: session.sales.city || "",
          stage: "ai_assistant",
          message: question,
          reply,
        });
        const isLeadIntent = /quote|quotation|order|buy|price|bulk|custom|printed|logo|branding/i.test(question);
        const specs = extractSpecs(question);
        if (isLeadIntent) {
          await logLead({
            phone: from,
            name: session.sales.name || "",
            city: session.sales.city || "",
            product: specs.product,
            size: specs.size,
            paper: specs.paper,
            quantity: specs.quantity,
            printing: specs.printing,
            notes: question,
            converted: true,
          });
        }
        if (!session.sales.askedNameCity && (!session.sales.name || !session.sales.city)) {
          session.sales.askedNameCity = true;
          await sendWhatsApp(from, "May I know your name and city?");
        }
        try {
          const { upsertDocuments } = require("../utils/rag");
          await upsertDocuments([
            { id: `q_${Date.now()}`, text: `Q: ${question}\nA: ${result.answer || ""}`, metadata: { source: "chat", user: from } }
          ], "customer_memory");
        } catch { }
      } catch (e) {
        await sendWhatsApp(from, "⚠️ Oops! Our assistant is taking a short break. Please try again in a few moments - we’ll be right back to help you 😊");
      }
      // Stay in ai_assistant stage
      return res.end();
    }

    if (session.stage === "check_availability_date") {
      const idx = parseInt(body);
      const availableDates = session.availableDates || [];
      if (
        isNaN(idx) ||
        idx < 1 ||
        idx > availableDates.length ||
        availableDates[idx - 1].isPast
      ) {
        await sendWhatsApp(
          from,
          "❌ Invalid date selection. Please reply with a number from the list."
        );
        return res.end();
      }

      const selectedDate = availableDates[idx - 1].value;
      const slots = await Slot.find();
      const courts = await Court.find();

      // In the check_availability_date stage
      let availabilityMsg = `💸 Available time slots for ${availableDates[idx - 1].display}:\n\n`;

      if (!slots.length || !courts.length) {
        availabilityMsg = "No time slots or courts configured. Please try another date or contact admin.";
      } else {
        let hasAvailableSlots = false;
        let slotMessages = [];

        for (const slot of slots) {
          if (!isTimeSlotAvailable(slot.time, selectedDate)) {
            continue;
          }

          let slotInfo = `*${slot.time}:*\n`;
          let hasAvailableCourts = false;

          for (const court of courts) {
            const availablePlayers = await getAvailablePlayersForSlot(
              selectedDate,
              slot.time,
              court._id
            );
            if (availablePlayers >= 2) {
              const duration = getDurationFromSlot(slot.time);
              const pricePerPlayer = duration === "2 hours" ? 300 : 200;
              slotInfo += `  • ${court.name}: ${availablePlayers} players available (₹${pricePerPlayer}/player for ${duration})\n`;
              hasAvailableCourts = true;
              hasAvailableSlots = true;
            }
          }

          if (hasAvailableCourts) {
            slotMessages.push(slotInfo);
          }
        }

        if (!hasAvailableSlots) {
          availabilityMsg = "No available time slots for this date. Please select another date.";
        } else {
          // Send availability in chunks to avoid exceeding character limit
          let currentChunk = availabilityMsg;

          for (const slotMsg of slotMessages) {
            if ((currentChunk + slotMsg + "\n").length > 1500) {
              await sendSplitMessage(from, currentChunk);
              currentChunk = slotMsg + "\n";
            } else {
              currentChunk += slotMsg + "\n";
            }
          }

          availabilityMsg = currentChunk + "\nReply with 'book' to make a booking or 'menu' to return to main menu.";
        }
      }

      await sendSplitMessage(from, availabilityMsg);
      session.stage = "after_availability";
      return res.end();
    }

    if (session.stage === "after_availability") {
      if (body === "book" || body.includes("book")) {
        session.stage = "choose_date";
        const availableDates = getNextSevenDays();
        let dateOptions = "💷 *Please select a date for your booking:*\n\n";
        availableDates.forEach((date, i) => {
          if (!date.isPast) {
            dateOptions += `*${i + 1}️⃣ ${date.display}*\n`;
          }
        });
        dateOptions += "\nReply with the date number.";
        session.availableDates = availableDates;
        await sendWhatsApp(from, dateOptions);
        return res.end();
      } else if (body === "menu" || body.includes("menu") || body.includes("main menu") ||
        body === "hi" ||
        body === "hello" ||
        body === "hey" ||
        body === "hii" ||
        body === "hiii" ||
        body === "hola" ||
        body === "restart" ||
        body === "start" ||
        body === "begin" ||
        body === "menu" ||
        body === "main menu" ||
        body === "back" ||
        body === "home" ||
        body === "exit" ||
        body === "end" ||
        body === "stop" ||
        body === "reset" ||
        body === "thanks" ||
        body === "thank you" ||
        body === "thankyou" ||
        body === "thx" ||
        body === "ty" ||
        body === "thank u" ||
        body === "ok" ||
        body === "okay" ||
        body === "cool" ||
        body === "done" ||
        body === "confirmed" ||
        body === "yes" ||
        body === "yep" ||
        body === "yo" ||
        body === "good morning" ||
        body === "good evening" ||
        body === "good night" ||
        body === "Thank you for confirming my booking." ||
        body.includes(["Hi", "Thank you"])
      ) {
        session.stage = "menu";
        await sendWhatsApp(
          from,
          `1. Book Court
2. My Bookings
3. Check Availability
4. Pricing & Rules
5. Contact Admin

Reply with the number or option name.`
        );
        return res.end();
      } else {
        await sendWhatsApp(
          from,
          "Please reply with 'book' to make a booking or 'menu' to return to main menu."
        );
        return res.end();
      }
    }

    if (session.stage === "choose_date") {
      const idx = parseInt(body);
      const availableDates = session.availableDates || [];

      if (
        isNaN(idx) ||
        idx < 1 ||
        idx > availableDates.length ||
        availableDates[idx - 1].isPast
      ) {
        await sendWhatsApp(
          from,
          "❌ Invalid date selection. Please reply with a number from the list."
        );
        return res.end();
      }

      const selectedDate = availableDates[idx - 1].value;
      session.draft = {
        date: selectedDate,
        dateDisplay: availableDates[idx - 1].display,
      };

      session.stage = "choose_players";

      let playerOptions = `👥 *Select Number of Players*\n\n`;
      playerOptions += `*Pricing Information:*\n`;
      playerOptions += `• 1 hour session: ₹200 per player\n`;
      playerOptions += `• 2 hours session: ₹300 per player\n\n`;
      playerOptions += `*Example Calculations:*\n`;
      playerOptions += `• 2 players for 1 hour: ₹400\n`;
      playerOptions += `• 3 players for 1 hour: ₹600\n`;
      playerOptions += `• 4 players for 1 hour: ₹800\n`;
      playerOptions += `• 2 players for 2 hours: ₹600\n`;
      playerOptions += `• 3 players for 2 hours: ₹900\n`;
      playerOptions += `• 4 players for 2 hours: ₹1200\n\n`;
      playerOptions += `Minimum: 2 players\nMaximum: 4 players per court\n\n`;
      playerOptions += `Reply with the number of players (2, 3, or 4).`;

      await sendWhatsApp(from, playerOptions);
      return res.end();
    }

    if (session.stage === "choose_players") {
      const playerCount = parseInt(body);
      if (isNaN(playerCount) || playerCount < 2 || playerCount > 4) {
        await sendWhatsApp(
          from,
          "❌ Invalid player count. Please reply with 2, 3, or 4 players."
        );
        return res.end();
      }

      session.draft.playerCount = playerCount;

      const slots = await Slot.find({ status: "Active" });
      if (!slots.length) {
        await sendWhatsApp(from, "No slots configured. Contact admin.");
        delete sessions[from];
        return res.end();
      }

      // Filter available slots based on time and player availability
      const courts = await Court.find({ status: "Active" });
      let availableSlots = [];

      for (const slot of slots) {
        if (!isTimeSlotAvailable(slot.time, session.draft.date)) {
          continue;
        }

        // Check if any court has enough capacity for requested players
        let hasAvailableCourt = false;
        for (const court of courts) {
          const isAvailable = await isSlotAvailableForPlayers(
            session.draft.date,
            slot.time,
            court._id,
            playerCount
          );
          if (isAvailable) {
            hasAvailableCourt = true;
            break;
          }
        }

        if (hasAvailableCourt) {
          availableSlots.push(slot);
        }
      }

      if (!availableSlots.length) {
        await sendWhatsApp(
          from,
          `❌ No available time slots for ${session.draft.dateDisplay} with ${playerCount} players.

Please reply with:
• 'back' to choose different number of players
• 'menu' to return to main menu`
        );
        session.stage = "no_slots_available";
        return res.end();
      }

      function parseTimeToNumber(slotTime) {
        const [startTime] = slotTime.split(" - ");
        const [time, meridian] = startTime.trim().split(" ");

        let [hour, minute] = time.split(":").map(Number);

        if (meridian === "PM" && hour !== 12) hour += 12;
        if (meridian === "AM" && hour === 12) hour = 0;

        return hour * 60 + minute;
      }

      // Sort available slots array based on start time
      availableSlots.sort((a, b) => {
        return parseTimeToNumber(a.time) - parseTimeToNumber(b.time);
      });

      let msg = `⏰ Available time slots for ${session.draft.dateDisplay} (${playerCount} players):\n\n`;
      availableSlots.forEach((s, i) => {
        const duration = getDurationFromSlot(s.time);
        const pricePerPlayer = duration === "2 hours" ? 300 : 200;
        const totalPrice = pricePerPlayer * session.draft.playerCount;
        msg += `*${i + 1}. ${s.time}* (${duration}) - ₹${totalPrice}\n`;
      });
      msg += "\nReply with the slot number.";
      msg += "\nReply 'back' to choose different number of players.";

      session.slots = availableSlots;
      session.stage = "choose_slot";
      await sendWhatsApp(from, msg);
      return res.end();
    }

    if (session.stage === "no_slots_available") {
      if (body === "back") {
        session.stage = "choose_players";

        let playerOptions = `👥 *Select Number of Players*\n\n`;
        playerOptions += `*Pricing Information:*\n`;
        playerOptions += `• 1 hour session: ₹200 per player\n`;
        playerOptions += `• 2 hours session: ₹300 per player\n\n`;
        playerOptions += `*Example Calculations:*\n`;
        playerOptions += `• 2 players for 1 hour: ₹400\n`;
        playerOptions += `• 3 players for 1 hour: ₹600\n`;
        playerOptions += `• 4 players for 1 hour: ₹800\n`;
        playerOptions += `• 2 players for 2 hours: ₹600\n`;
        playerOptions += `• 3 players for 2 hours: ₹900\n`;
        playerOptions += `• 4 players for 2 hours: ₹1200\n\n`;
        playerOptions += `Minimum: 2 players\nMaximum: 4 players per court\n\n`;
        playerOptions += `Reply with the number of players (2, 3, or 4).`;

        await sendWhatsApp(from, playerOptions);
        return res.end();
      } else if (body === "hi" ||
        body === "hello" ||
        body === "hey" ||
        body === "hii" ||
        body === "hiii" ||
        body === "hola" ||
        body === "restart" ||
        body === "start" ||
        body === "begin" ||
        body === "menu" ||
        body === "main menu" ||
        body === "back" ||
        body === "home" ||
        body === "exit" ||
        body === "end" ||
        body === "stop" ||
        body === "reset" ||
        body === "thanks" ||
        body === "thank you" ||
        body === "thankyou" ||
        body === "thx" ||
        body === "ty" ||
        body === "thank u" ||
        body === "ok" ||
        body === "okay" ||
        body === "cool" ||
        body === "done" ||
        body === "confirmed" ||
        body === "yes" ||
        body === "yep" ||
        body === "yo" ||
        body === "good morning" ||
        body === "good evening" ||
        body === "good night" ||
        body === "Thank you for confirming my booking." ||
        body.includes(["Hi", "Thank you"])
      ) {
        session.stage = "menu";
        await sendWhatsApp(
          from,
          `1. Book Court
2. My Bookings
3. Check Availability
4. Pricing & Rules
5. Contact Admin

Reply with the number or option name.`
        );
        return res.end();
      } else {
        await sendWhatsApp(
          from,
          "Please reply with 'back' to choose different players or 'menu' for main menu."
        );
        return res.end();
      }
    }

    if (session.stage === "choose_slot") {
      if (body === "back") {
        session.stage = "choose_players";

        let playerOptions = `👥 *Select Number of Players*\n\n`;
        playerOptions += `*Pricing Information:*\n`;
        playerOptions += `• 1 hour session: ₹200 per player\n`;
        playerOptions += `• 2 hours session: ₹300 per player\n\n`;
        playerOptions += `Minimum: 2 players\nMaximum: 4 players per court\n\n`;
        playerOptions += `Reply with the number of players (2, 3, or 4).`;

        await sendWhatsApp(from, playerOptions);
        return res.end();
      }

      const idx = parseInt(body);
      const slots = session.slots || [];
      if (isNaN(idx) || idx < 1 || idx > slots.length) {
        await sendWhatsApp(
          from,
          "❌ Invalid slot. Reply with the slot number or 'back' to choose players."
        );
        return res.end();
      }

      const slot = slots[idx - 1];
      session.draft.slot = slot.time;
      session.draft.slotId = slot._id;
      session.draft.duration = getDurationFromSlot(slot.time);

      // Get available courts for this slot and player count
      const courts = await Court.find();
      const availableCourts = [];

      for (const court of courts) {
        const isAvailable = await isSlotAvailableForPlayers(
          session.draft.date,
          session.draft.slot,
          court._id,
          session.draft.playerCount
        );

        if (isAvailable) {
          availableCourts.push(court);
        }
      }

      if (!availableCourts.length) {
        await sendWhatsApp(
          from,
          "No courts available for this time slot. Please select another time slot."
        );
        session.stage = "choose_slot";
        return res.end();
      }

      let msg = `🎾 Available courts for ${session.draft.dateDisplay} – ${session.draft.slot} (${session.draft.playerCount} players):\n\n`;
      availableCourts.forEach((c, i) => {
        const courtAmount = calculateAmount(session.draft.duration, session.draft.playerCount);
        msg += `*${i + 1}. ${c.name}* - ₹${courtAmount} (${session.draft.duration})\n`;
      });
      msg += "\nReply with the court number.";
      msg += "\nReply 'back' to choose different time slot.";

      session.courts = availableCourts;
      session.stage = "choose_court";
      await sendWhatsApp(from, msg);
      return res.end();
    }

    if (session.stage === "choose_court") {
      if (body === "back") {
        session.stage = "choose_slot";
        let msg = `⏰ Available time slots for ${session.draft.dateDisplay} (${session.draft.playerCount} players):\n\n`;
        session.slots.forEach((s, i) => {
          const duration = getDurationFromSlot(s.time);
          const pricePerPlayer = duration === "2 hours" ? 300 : 200;
          const totalPrice = pricePerPlayer * session.draft.playerCount;
          msg += `*${i + 1}. ${s.time}* (${duration}) - ₹${totalPrice}\n`;
        });
        msg += "\nReply with the slot number.";
        msg += "\nReply 'back' to choose different number of players.";
        await sendWhatsApp(from, msg);
        return res.end();
      }

      const idx = parseInt(body);
      const courts = session.courts || [];
      if (isNaN(idx) || idx < 1 || idx > courts.length) {
        await sendWhatsApp(
          from,
          "❌ Invalid court. Reply with court number or 'back' for time slots."
        );
        return res.end();
      }

      const court = courts[idx - 1];
      session.draft.courtId = court._id;
      session.draft.courtName = court.name;
      session.draft.amount = calculateAmount(
        session.draft.duration,
        session.draft.playerCount
      );

      // Generate booking summary and show payment link directly
      const bookingId = await generateBookingId();
      const invoiceNumber = await generateInvoiceNumber();

      const summary = `💺 *Booking Summary:*

🆔 Booking ID: ${bookingId}
📅 Date: ${session.draft.dateDisplay}
⏰ Time: ${session.draft.slot}
⏱️ Duration: ${session.draft.duration}
🎾 Court: ${session.draft.courtName}
👥 Players: ${session.draft.playerCount}
💵 Total Amount: ₹${session.draft.amount}

*Payment Required to Confirm Booking*

💰 *Payment Link:* ${createPaymentLink(bookingId)}

⚠️ *Payment expires in 5 minutes*

Reply 'cancel' to cancel this booking.
Reply 'menu' to return to main menu.`;

      // Create booking with pending_payment status
      const booking = await Booking.create({
        bookingId: bookingId,
        invoiceNumber: invoiceNumber,
        whatsapp: from,
        date: session.draft.date,
        slot: session.draft.slot,
        slotId: session.draft.slotId,
        courtId: session.draft.courtId,
        courtName: session.draft.courtName,
        duration: session.draft.duration,
        playerCount: session.draft.playerCount,
        amount: session.draft.amount,
        status: "pending_payment",
      });

      session.bookingId = booking._id;
      session.stage = "payment_pending";

      await sendWhatsApp(from, summary);
      return res.end();
    }

    if (session.stage === "payment_pending") {
      if (body.includes("paid")) {
        const booking = await Booking.findById(session.bookingId);
        if (!booking) {
          await sendWhatsApp(from, "Booking not found.");
          delete sessions[from];
          return res.end();
        }

        // Check if the court still has capacity
        const isAvailable = await isSlotAvailableForPlayers(
          booking.date,
          booking.slot,
          booking.courtId,
          booking.playerCount
        );

        if (!isAvailable) {
          await sendWhatsApp(
            from,
            "Sorry, this court doesn't have enough capacity anymore. Please try booking another court or time slot."
          );

          // Refund logic would go here
          booking.status = "cancelled";
          await booking.save();

          delete session.bookingId;
          session.stage = "menu";
          return res.end();
        }

        booking.status = "confirmed";
        booking.confirmedAt = new Date();
        await booking.save();

        // Generate QR code for check-in
        const qrCodeLink = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${booking.bookingId}`;
        const receiptUrl = `${process.env.BASE_URL || "http://localhost:4000"
          }/payment/receipt/${booking._id}`;

        await sendWhatsApp(
          from,
          `✅ *Booking Confirmed!*

🆔 Booking ID: ${booking.bookingId}
📅 Date: ${session.draft.dateDisplay}
⏰ Time: ${booking.slot}
⏱️ Duration: ${booking.duration}
🎾 Court: ${booking.courtName}
👥 Players: ${booking.playerCount}
💵 Total Amount: ₹${booking.amount}
📄 Invoice: ${booking.invoiceNumber}

QR Code for check-in: ${qrCodeLink}
Receipt: ${receiptUrl}

Reply 'menu' for main menu.`
        );

        session.stage = "booking_confirmed";
        return res.end();
      } else if (body === "cancel" || body.includes("cancel")) {
        const booking = await Booking.findById(session.bookingId);
        if (booking) {
          booking.status = "cancelled";
          await booking.save();
          await sendWhatsApp(
            from,
            "❌ Booking cancelled successfully. If your payment was successful for this cancelled booking, please contact our support team for a refund. Reply 'menu' to return to main menu."
          );
        } else {
          await sendWhatsApp(
            from,
            "Booking not found. Reply 'menu' to return to main menu."
          );
        }
        delete sessions[from];
        return res.end();
      } else if (body === "menu") {
        session.stage = "menu";
        await sendWhatsApp(
          from,
          `1. Book Court
2. My Bookings
3. Check Availability
4. Pricing & Rules
5. Contact Admin

Reply with the number or option name.`
        );
        return res.end();
      } else {
        await sendWhatsApp(
          from,
          "Please reply with 'cancel' to cancel your booking, or 'menu' to return to the main menu."
        );
        return res.end();
      }
    }

    if (session.stage === "booking_confirmed") {
      if (body === "menu") {
        session.stage = "menu";
        await sendWhatsApp(
          from,
          `1. Book Court
2. My Bookings
3. Check Availability
4. Pricing & Rules
5. Contact Admin

Reply with the number or option name.`
        );
        return res.end();
      } else {
        await sendWhatsApp(
          from,
          "Please reply with 'menu' to return to main menu."
        );
        return res.end();
      }
    }

    // Default fallback
    await sendWhatsApp(
      from,
      "Sorry, I didn't understand. Reply 'hi' to restart or 'menu' to see options."
    );
    res.end();
  } catch (error) {
    console.error("Error in Twilio webhook:", error);
    const phoneNumber = req.body.From || "unknown";
    try {
      await sendWhatsApp(
        phoneNumber,
        "Sorry, something went wrong. Please try again later or contact support."
      );
    } catch (innerError) {
      console.error("Failed to send error message:", innerError);
    }
    res.end();
  }
});

module.exports = router;
