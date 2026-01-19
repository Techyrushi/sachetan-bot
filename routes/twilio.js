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
const { logConversation, logLead, logUserMedia } = require("../utils/sheets");
const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const twilio = require("twilio");

const client = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Helper to download media
async function downloadMedia(url, filename) {
  const uploadDir = path.join(__dirname, "../public/uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const writer = fs.createWriteStream(path.join(uploadDir, filename));

  // Twilio requires Basic Auth for media downloads if enabled in settings
  // We use the Account SID and Auth Token from environment variables
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const headers = {};
  if (accountSid && authToken) {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: headers
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function getSafeMediaPayload(imageUrl) {
  if (!imageUrl) return {};
  try {
    const head = await axios.head(imageUrl);
    const lenRaw = head.headers["content-length"] || head.headers["Content-Length"];
    const len = lenRaw ? parseInt(lenRaw, 10) : 0;
    if (!len || len > 4 * 1024 * 1024) {
      // Download and compress
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      let img = sharp(response.data).rotate();
      // Resize to max width 1200px to reduce size
      img = img.resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 });
      let buffer = await img.toBuffer();
      // If still large, reduce quality iteratively
      let quality = 75;
      while (buffer.length > 4 * 1024 * 1024 && quality >= 50) {
        buffer = await sharp(buffer).jpeg({ quality }).toBuffer();
        quality -= 5;
      }
      if (buffer.length > 4 * 1024 * 1024) {
        // As a last resort, downscale further
        buffer = await sharp(buffer).resize({ width: 900 }).jpeg({ quality: 60 }).toBuffer();
      }
      // Save to public/uploads
      const uploadDir = path.join(__dirname, "../public/uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const filename = `compressed_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadDir, filename), buffer);
      const baseUrl = process.env.BASE_URL;
      const mediaUrl = `${baseUrl}/uploads/${filename}`;
      return { mediaUrl };
    } else {
      return { mediaUrl: imageUrl };
    }
  } catch (e) {
    console.error("Media HEAD failed, sending without media:", e);
    try {
      // Attempt compression anyway
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const buffer = await sharp(response.data).resize({ width: 1200 }).jpeg({ quality: 80 }).toBuffer();
      const uploadDir = path.join(__dirname, "../public/uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const filename = `compressed_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadDir, filename), buffer);
      const mediaUrl = `${process.env.BASE_URL}/uploads/${filename}`;
      return { mediaUrl };
    } catch (err2) {
      console.error("Fallback compression failed:", err2);
      return {};
    }
  }
}

const router = express.Router();

// Ensure Session Table
async function ensureSessionTable() {
  try {
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS tbl_chat_sessions (
        phone VARCHAR(20) PRIMARY KEY,
        stage VARCHAR(50) DEFAULT 'menu',
        previous_stage VARCHAR(50) NULL,
        user_type VARCHAR(50) NULL,
        last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Backfill: add previous_stage if missing (safe when column exists)
    try {
      await mysqlPool.query(`
        ALTER TABLE tbl_chat_sessions
        ADD COLUMN previous_stage VARCHAR(50) NULL
      `);
    } catch (e) {
      // Ignore error if column already exists
    }

    try {
      await mysqlPool.query(`
        ALTER TABLE tbl_chat_sessions
        ADD COLUMN user_type VARCHAR(50) NULL
      `);
    } catch (e) { }

    // Chat History Table
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS tbl_chat_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        sender ENUM('user', 'bot') NOT NULL,
        message TEXT,
        media_url TEXT,
        message_sid VARCHAR(100),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_phone (phone),
        INDEX idx_created_at (created_at),
        INDEX idx_message_sid (message_sid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Add message_sid column
    try {
      await mysqlPool.query(`
        ALTER TABLE tbl_chat_history
        ADD COLUMN message_sid VARCHAR(100) NULL,
        ADD INDEX idx_message_sid (message_sid)
      `);
    } catch (e) {
      // Ignore if column already exists
    }

    // Add status column
    try {
      await mysqlPool.query(`
        ALTER TABLE tbl_chat_history
        ADD COLUMN status VARCHAR(50) NULL
      `);
    } catch (e) {
      // Ignore if column already exists
    }

    // Add context column for AI state
    try {
      await mysqlPool.query(`
        ALTER TABLE tbl_chat_sessions
        ADD COLUMN context TEXT NULL
      `);
    } catch (e) {
      // Ignore if column already exists
    }
  } catch (err) {
    console.error("Session table error:", err);
  }
}
ensureSessionTable();

async function logChatToDB(phone, sender, message, mediaUrl = null, messageSid = null, status = null) {
  try {
    await mysqlPool.query(
      "INSERT INTO tbl_chat_history (phone, sender, message, media_url, message_sid, status) VALUES (?, ?, ?, ?, ?, ?)",
      [phone, sender, message, mediaUrl, messageSid, status]
    );
  } catch (err) {
    console.error("Error logging chat to DB:", err);
  }
}

async function sendAndLog(to, body, options = {}) {
  try {
    const message = await sendWhatsApp(to, body, options);
    const messageSid = message ? message.sid : null;
    const status = message ? message.status : null;
    await logChatToDB(to, 'bot', body, options.mediaUrl, messageSid, status);
  } catch (err) {
    console.error("Error in sendAndLog:", err);
  }
}

// Status Callback Endpoint
router.post("/status", async (req, res) => {
  const messageSid = req.body.MessageSid;
  const messageStatus = req.body.MessageStatus;

  console.log(`Twilio Status Update: SID=${messageSid}, Status=${messageStatus}`);

  if (messageSid && messageStatus) {
    try {
      await mysqlPool.query(
        "UPDATE tbl_chat_history SET status = ? WHERE message_sid = ?",
        [messageStatus, messageSid]
      );
    } catch (err) {
      console.error("Error updating message status:", err);
    }
  }

  res.sendStatus(200);
});

// GET Endpoint for easy browser verification
router.get("/status", (req, res) => {
  res.send("✅ Twilio Status Callback Endpoint is Active and Listening!");
});

// Test-only: compress a given image URL and return the media URL
router.get("/test/compress", async (req, res) => {
  const u = req.query.url;
  if (!u) return res.status(400).json({ error: "url query required" });
  try {
    const media = await getSafeMediaPayload(u);
    res.json({ ok: true, media });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function updateSessionTimestamp(phone, stage) {
  try {
    await mysqlPool.query(
      "INSERT INTO tbl_chat_sessions (phone, stage) VALUES (?, ?) ON DUPLICATE KEY UPDATE stage = ?, last_message_at = NOW()",
      [phone, stage, stage]
    );
  } catch (err) {
    console.error("Session update error:", err);
  }
}

// Helper function to get the latest counter from database
async function getLatestCounter(counterType) {
  try {
    // You can create a separate counters collection or use the bookings collection
    const latestBooking = await Booking.findOne().sort({ createdAt: -1 });

    if (!latestBooking) {
      return 0; // No bookings yet, start from 0
    }

    if (counterType === "booking") {
      // Extract number from bookingId like "NP-01" -> 1
      const match = latestBooking.bookingId.match(/NP-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    } else if (counterType === "invoice") {
      // Extract number from invoiceNumber like "NP-2025-01" -> 1
      const match = latestBooking.invoiceNumber.match(/NP-\d+-(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }

    return 0;
  } catch (error) {
    console.error("Error getting latest counter:", error);
    return 0;
  }
}

// Add this helper function to split long messages
async function sendSplitMessage(phoneNumber, message, maxLength = 1500) {
  if (message.length <= maxLength) {
    await sendAndLog(phoneNumber, message);
    return;
  }

  // Split by double newlines first to preserve paragraphs
  const paragraphs = message.split("\n\n");
  let currentMessage = "";

  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed limit, send current message and start new one
    if (
      (currentMessage + paragraph + "\n\n").length > maxLength &&
      currentMessage
    ) {
      await sendAndLog(phoneNumber, currentMessage.trim());
      currentMessage = paragraph + "\n\n";
    } else {
      currentMessage += paragraph + "\n\n";
    }
  }

  // Send any remaining content
  if (currentMessage.trim()) {
    await sendAndLog(phoneNumber, currentMessage.trim());
  }
}

// Helper function to generate Booking ID (NP-01, NP-02, etc.)
async function generateBookingId() {
  const latestCounter = await getLatestCounter("booking");
  const nextCounter = latestCounter + 1;
  const id = `NP-${nextCounter.toString().padStart(2, "0")}`;
  return id;
}

// Helper function to generate Invoice Number (NP-2025-01, etc.)
async function generateInvoiceNumber() {
  const latestCounter = await getLatestCounter("invoice");
  const nextCounter = latestCounter + 1;
  const currentYear = new Date().getFullYear();
  const invoiceNo = `NP-${currentYear}-${nextCounter
    .toString()
    .padStart(2, "0")}`;
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
  return html
    .replace(/<[^>]*>?/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
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

    await sendAndLog(
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

const rateLimit = new Map(); // phone -> [timestamps]

router.post("/", async (req, res) => {
  try {
    const from = req.body.From;
    let body = (req.body.Body || "").trim().toLowerCase();

    // 0. Rate Limiting (10 msgs per 60s)
    const now = Date.now();
    if (!rateLimit.has(from)) rateLimit.set(from, []);
    const timestamps = rateLimit.get(from);
    // Remove timestamps older than 60s
    while (timestamps.length > 0 && now - timestamps[0] > 60000) {
      timestamps.shift();
    }
    timestamps.push(now);
    if (timestamps.length > 10) {
      await sendWhatsApp(from, "⚠️ You are sending messages too quickly.\nPlease wait a few seconds so I can assist you properly 🙂");
      return res.end();
    }

    const numMedia = parseInt(req.body.NumMedia || 0);

    // 1. Log incoming text if present (Always log user message first)
    if (req.body.Body) {
      await logChatToDB(from, 'user', req.body.Body, null, req.body.MessageSid, req.body.SmsStatus || 'received');
    }

    // 2. Check DB for Manual Mode
    let isManual = false;
    try {
      const [rows] = await mysqlPool.query("SELECT stage FROM tbl_chat_sessions WHERE phone = ? LIMIT 1", [from]);
      if (rows.length && rows[0].stage === 'manual') {
        isManual = true;
      }
    } catch (e) {
      console.error("DB Check Error:", e);
    }

    if (isManual) {
      // Update timestamp only, keep stage manual
      await mysqlPool.query("UPDATE tbl_chat_sessions SET last_message_at = NOW() WHERE phone = ?", [from]);
      return res.end();
    }

    // 3. Update Session Timestamp for Bot (only if not manual)
    await updateSessionTimestamp(from, router.sessions && router.sessions[from] ? router.sessions[from].stage : 'menu');

    const userName = from.split("+")[1] || "there";

    router.sessions = router.sessions || {};
    const sessions = router.sessions;

    // 1. Load Session from DB if not in memory
    if (!sessions[from]) {
      try {
        const [rows] = await mysqlPool.query("SELECT stage, user_type, context FROM tbl_chat_sessions WHERE phone = ? LIMIT 1", [from]);
        if (rows.length) {
          const dbStage = rows[0].stage || "menu";
          const dbType = rows[0].user_type || null;
          let dbContext = {};
          try {
            if (rows[0].context) dbContext = JSON.parse(rows[0].context);
          } catch (e) { }

          sessions[from] = { stage: dbStage, context: dbContext };
          if (dbType) sessions[from].userType = dbType;
        } else {
          sessions[from] = { stage: "menu", context: {} };
        }
      } catch {
        sessions[from] = { stage: "menu", context: {} };
      }
    }

    const session = sessions[from];

    // Handle Media Uploads
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;
      const ext = mediaType.split("/")[1] || "bin";
      const filename = `user_${Date.now()}.${ext}`;

      try {
        console.log(`Downloading media from ${mediaUrl} to ${filename}`);
        await downloadMedia(mediaUrl, filename);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
        const localMediaUrl = `${baseUrl}/uploads/${filename}`;

        console.log(`Media saved locally at: ${localMediaUrl}`);

        // Update Session Context with Media URL
        session.context = session.context || {};
        session.context.mediaUrl = localMediaUrl;

        // Persist context update
        await mysqlPool.query("UPDATE tbl_chat_sessions SET context = ? WHERE phone = ?", [JSON.stringify(session.context), from]);

        await logUserMedia(from, localMediaUrl);
        await logChatToDB(from, 'user', '[Media Upload]', localMediaUrl, req.body.MessageSid, req.body.SmsStatus || 'received');

        if (session.stage === 'custom_solutions') {
          await sendAndLog(from, "✅ Image received. Analyzing...");
          // Allow flow to proceed to custom_solutions logic
          // If body is empty, set a placeholder so greeting checks etc don't crash
          if (!req.body.Body) {
            req.body.Body = "I sent an image.";
            body = "i sent an image.";
          }
        } else {
          await sendAndLog(from, "✅ We have received your file. Our team will review it and get back to you with a customized solution.");

          await logConversation({
            phone: from,
            name: router.sessions?.[from]?.sales?.name || "User Media",
            city: router.sessions?.[from]?.sales?.city || "Unknown",
            stage: "media_upload",
            message: `[Media Upload] ${localMediaUrl}`,
            reply: "File received",
            mediaUrl: localMediaUrl
          });

          return res.end();
        }
      } catch (e) {
        console.error("Media download failed:", e);
        await logChatToDB(from, 'user', '[Media Upload Failed]', mediaUrl);
        await sendAndLog(from, "⚠️ We couldn't download your file. Please try sending it again.");
        return res.end();
      }
    }

    // Define keyword lists
    const greetingKeywords = [
      "hi", "hello", "hey", "hii", "hiii", "hola", "namaste", "namaskar",
      "start", "begin", "restart",
      "good morning", "good evening", "good night",
      "hi bot", "hello bot", "hi sachetan", "hello sachetan",
      "i want", "i need", "interested", "details", "inquiry", "enquiry",
      "saw this on facebook", "saw this on instagram", "fb ad", "insta ad", "ad"
    ];

    const menuKeywords = [
      "menu", "main menu", "back", "home", "exit", "end", "stop", "reset", "quit", "abort", "leave",
      "thanks", "thank you", "thankyou", "thx", "ty", "thank u",
      "ok", "okay", "cool", "done", "confirmed",
      "thank you for confirming my booking.",
      "go to menu", "Go to Menu" // Added explicit match for "Go to Menu" button text
    ];

    let isGreeting = greetingKeywords.some(k => body.startsWith(k)) || (body.includes("hi") && body.length < 10) || (body.includes("hello") && body.length < 10);
    const isMenu = menuKeywords.includes(body);

    // INTELLIGENT EXCEPTION:
    // If user says "I want..." but is already in 'custom_solutions', treat it as data, not a reset.
    if (session.stage === 'custom_solutions') {
      if (body.startsWith("i want") || body.startsWith("i need") || body.startsWith("interested")) {
        isGreeting = false;
      }
    }

    if (isGreeting || isMenu) {
      // Reset Session
      session.stage = "menu";
      session.context = {}; // Clear context on full reset? Or keep it? "Menu" usually implies fresh start.

      await mysqlPool.query("INSERT INTO tbl_chat_sessions (phone, stage, context) VALUES (?, 'menu', '{}') ON DUPLICATE KEY UPDATE stage = 'menu', last_message_at = NOW()", [from]);

      // Only send logo and full welcome for greetings (not for menu/back)
      if (isGreeting || isMenu) {
        const logoUrl = "https://sachetanpackaging.in/assets/uploads/sachetan_logos.png";
        await sendAndLog(from, "", { mediaUrl: logoUrl });
        await new Promise((r) => setTimeout(r, 2000)); // Wait 2s for media
      }

      await sendAndLog(
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
*2️⃣ Custom Solutions* - Product Queries  
*3️⃣ FAQ & Support* - Contact Us  
        _Reply with a number to proceed._`,
        { contentSid: process.env.TWILIO_CONTENT_SID_SERVICES }
      );
      return res.end();
    }

    if (session.stage === "select_user_type") {
      let type = "";
      if (body === "1" || body.includes("home")) type = "Homebakers";
      else if (body === "2" || body.includes("store") || body.includes("bulk")) type = "Store Owner/ Bulk Buyer";
      else if (body === "3" || body.includes("sweet")) type = "Sweet Shop Owner";

      if (type) {
        session.userType = type;
        session.stage = "custom_solutions";
        try {
          await mysqlPool.query("INSERT INTO tbl_chat_sessions (phone, stage, user_type) VALUES (?, 'custom_solutions', ?) ON DUPLICATE KEY UPDATE stage='custom_solutions', user_type=VALUES(user_type), last_message_at=NOW()", [from, type]);
        } catch { }
        await sendAndLog(from, `✅ You selected: *${type}*

To help you better, please share:
📦 Product (e.g., cake box, cake base, paper bag, laminated box, customized box, sweet packaging box)  
📏 Size or usage (e.g., 1 kg cake)  
🎨 Plain or printed design  
🔢 Approximate quantity  

💬 *Language Note:*  
You can chat with our team in **your local language or English** — whatever you’re comfortable with 😊  

Not sure about all the details? No worries at all! Just share what you know, and we’ll guide you step by step to the best packaging solution 💛`);
      } else {
        await sendAndLog(
          from,
          `⚠️ Please select a valid option (1, 2, or 3).

👇 *Please select your business type:*

*1️⃣ Homebakers*
*2️⃣ Store Owner/ Bulk Buyer*
*3️⃣ Sweet Shop Owner*

_Reply with a number to proceed._`,
          { contentSid: process.env.TWILIO_CONTENT_SID_USER_TYPE }
        );
      }
      return res.end();
    }

    if (session.stage === "custom_solutions") {
      let queryText = body;
      const currentContext = session.context || {};

      // 1. Lead Collection (Name & City)
      if (!currentContext.name || !currentContext.city) {
        // If we already asked, this message is the answer
        if (currentContext.askingForDetails) {
          let name = body;
          let city = "Unknown";
          const cleanBody = body.replace(/my name is/i, "").replace(/i am/i, "").trim();

          if (cleanBody.includes(",")) {
            const parts = cleanBody.split(",");
            name = parts[0].trim();
            city = parts.slice(1).join(" ").trim();
          } else if (cleanBody.toLowerCase().includes(" from ")) {
            const parts = cleanBody.toLowerCase().split(" from ");
            name = parts[0].trim();
            city = parts[1].trim();
          } else {
            name = cleanBody;
          }

          // Capitalize
          name = name.replace(/\b\w/g, l => l.toUpperCase());
          city = city.replace(/\b\w/g, l => l.toUpperCase());

          currentContext.name = name;
          currentContext.city = city;
          delete currentContext.askingForDetails;

          const originalQuery = currentContext.pendingQuery || "";
          delete currentContext.pendingQuery;

          // Log Lead
          await logLead({
            phone: from,
            name: name,
            city: city,
            converted: false
          });

          await sendAndLog(from, `Thanks ${name.split(' ')[0]}! 😊, Just a moment… I'm preparing the best options for you 🧠✨`);

          if (originalQuery) {
            queryText = originalQuery; // Use the original question for AI
          } else {
            await sendAndLog(from, "What product are you looking for today? 📦");
            session.context = currentContext;
            await mysqlPool.query("UPDATE tbl_chat_sessions SET context = ?, last_message_at = NOW() WHERE phone = ?", [JSON.stringify(currentContext), from]);
            return res.end();
          }
        } else {
          // First time asking
          currentContext.askingForDetails = true;
          currentContext.pendingQuery = body; // Save current message

          session.context = currentContext;
          await mysqlPool.query("UPDATE tbl_chat_sessions SET context = ?, last_message_at = NOW() WHERE phone = ?", [JSON.stringify(currentContext), from]);

          await sendAndLog(from, "To generate a proper quotation, could you please share your **Full Name and City**? 🏙️\n\n_Example: Rahul Patil, Nashik_");
          return res.end();
        }
      }

      // 2. Prepare Prompt
      const contextString = JSON.stringify(currentContext, null, 2);

      // SEND IMMEDIATE 200 OK TO TWILIO TO PREVENT TIMEOUT
      // AND MARK AS READ IF POSSIBLE
      res.status(200).end();

      if (client && req.body.MessageSid) {
        client.messages(req.body.MessageSid).update({ status: 'read' }).catch(e => console.error("Read status failed", e.message));
      }

      const systemPrompt = `You are a trained packaging sales executive for Sachetan Packaging.
Your job is to Convert WhatsApp conversations into accurate quotations and real orders.

STRICT SCOPE & DATA RULE:
You are assisting a "${session.userType}".
You must ONLY answer questions based on the provided Context Data for this user type.
If the user asks about something completely unrelated to packaging or this business type (e.g. "Sell me a car", "recipe for cake"), you must politely refuse and steer them back to packaging.
If the user wants to restart or exit, guide them to type "menu".

HUMAN-LIKE PERSONA:
- Be polite, friendly, and professional.
- Use emojis naturally 🎂📦✨.
- Auto-correct typos (e.g. "kek box" -> "Cake Box").
- Do NOT mention "AI", "Bot", or "Database".
- If you don't understand, ask clarifying questions like a human would ("Sorry, did you mean...?", "Could you please specify...?")

IMAGE HANDLING:
You have access to a list of "Image Option: filename | URL: url".
If the user asks for a specific design (e.g. "one piece"), scan the filenames of the available images.
If a filename contains the requested keyword (e.g. "one_piece" matches "one piece"), include that specific image using [MEDIA:URL].
Example: User asks "show me one piece", you find "Image Option: one_piece_box.jpg | URL: ...", so you reply "Here is the One Piece Box. [MEDIA:https://.../one_piece_box.jpg]"
If no specific filename matches, you can still show a relevant generic image from the list.
ONLY use images explicitly provided in the context.

For every user, continuously store:
Product name
Size
Printing (plain / printed)
Material (if given)
Quantity
Previous selections
Quoted Rate (store the last quoted rate to maintain consistency)

When the user says:
price, rate, total, how much, quotation, amount

You must use the last stored values and calculate automatically.
If any field is missing, ask only for the missing field do not reset the conversation.

🧠 Smart Language & Auto-Correction
You must understand: English, Hindi, Marathi, Hinglish, Typos, Spoken language.
Recognize "Hi, "Hii", "Hlo", "Hello" as greetings if context implies.
if User Type "quit", "exit", "abort" then show menu.
Never say “I don’t understand” — infer intent.

🔢 Pricing & Quantity Rules (CRITICAL):
1. Minimum Order Quantity (MOQ):
   - If User Type is "Store Owner/ Bulk Buyer": MOQ is 1500 pcs. If user asks < 1500, inform them politely and suggest 1500 for best rates.
   - If User Type is "Sweet Shop Owner": MOQ is 200 pcs.
   - If User Type is "Homebaker": MOQ is 50 pcs.

2. Quantity-Based Pricing Logic:
   - If Quantity > 2000: Use the "Bulk Rate" (Low Value).
   - If Quantity <= 2000: Use the "Standard Rate" (High Value).
   - If only one rate is found in context, use that single rate.
   - Apply this logic consistently.

3. Price Consistency Rule:
   - Calculate rates based on the rules.
   - You MAY show the calculated rates to the user.

✅ QUOTATION DISPLAY:
- You ARE allowed to show the calculated price/quotation to the user.
- HOWEVER, you MUST append the following disclaimer message to EVERY quotation:

   "💰 *Estimated Quote:* [Insert Price Details]

   ⚠️ *Note:* This is an approximate rate. For a final quotation and potential bulk purchase discounts, please talk to our team or share your requirements. Our team member will contact you to give you the best quotation."

🧾 Quotation Flow:
When the user asks for price/rate/quotation, and you have sufficient details (Product, Size, Qty, etc.):
1. Calculate the price internally based on the rules.
2. Generate the <CONTEXT_JSON> with the full calculated details (rates, subtotal, gst, total) and set "status": "quotation_ready".
3. Reply to the user with the calculated price details followed by the MANDATORY disclaimer above.

🧮 4️⃣ Calculation Rules
Always:
1. Multiply quantity × rate = Subtotal
2. Determine GST Rate:
   - IF User Type is "Store Owner/ Bulk Buyer" AND Product is "MDF Cake Base" (or contains "MDF"): GST = 18% (Subtotal × 0.18)
   - ELSE: GST = 5% (Subtotal × 0.05)
3. Total = Subtotal + GST
4. Round Total to nearest rupee
Never guess quantity.
Never skip GST.

🤝 LEAD HANDOFF:
Once you have gathered the details and the user asks for price:
1. Output the polite "Thank you" message.
2. Output <CONTEXT_JSON> with:
   - "status": "quotation_ready"
   - "product", "size", "material", "quantity", "quotedRate", "subtotal", "gst", "total"
   - For multiple items, include the "items" array with details.
   - Include "name" and "city" in the JSON if known.

STATE MANAGEMENT:
You must extract the current Order Context from the conversation.
At the END of your response, you MUST output the updated context in a JSON block like this:
<CONTEXT_JSON>
{
  "product": "...",
  "size": "...",
  "printing": "...",
  "material": "...",
  "quantity": "...",
  "quotedRate": "6.50"
}
</CONTEXT_JSON>
Only update fields that are present or changed. Keep others as is.
Current Context: ${contextString}
`;

      try {
        // 3. Query RAG (Search for product info/rates)
        // We use the user's message + current product context to find relevant rates
        const searchTerms = queryText + " " + (currentContext.product || "");

        // FILTER BY USER TYPE
        const filter = session.userType ? { type: session.userType } : {};

        const ragResponse = await queryRag(searchTerms, 3, "website_docs", filter, false, systemPrompt);

        let reply = ragResponse.answer;
        let newContext = currentContext;

        // 4. Extract JSON Context
        const jsonMatch = reply.match(/<CONTEXT_JSON>([\s\S]*?)<\/CONTEXT_JSON>/);
        if (jsonMatch) {
          try {
            const extractedContext = JSON.parse(jsonMatch[1]);
            newContext = { ...currentContext, ...extractedContext };

            const productChanged = newContext.product !== currentContext.product;
            const quantityChanged = newContext.quantity !== currentContext.quantity;

            if (productChanged || quantityChanged) {
              await logLead({
                phone: from,
                product: newContext.product,
                size: newContext.size,
                quantity: newContext.quantity,
                printing: newContext.printing,
                notes: "In Discussion",
                converted: false,
              });
            }

            let createdOrder = null;
            const isConfirmed = newContext.status === "confirmed" || newContext.status === "quotation_ready";
            const hasOrderId = !!newContext.orderId;

            if (isConfirmed && !hasOrderId) {
              let items = [];

              if (Array.isArray(newContext.items) && newContext.items.length > 0) {
                items = newContext.items
                  .map((it, index) => {
                    const qty = Number(it.quantity || it.qty || 0) || 0;
                    const rate =
                      Number(
                        it.rate ||
                        it.price ||
                        it.ratePerPiece ||
                        it.rate_per_piece ||
                        it.pricePerUnit
                      ) || 0;
                    let total = Number(it.total || 0);
                    if (!total && qty && rate) {
                      total = qty * rate;
                    }
                    if (!qty || !total) {
                      return null;
                    }
                    return {
                      productId: String(it.productId || `QUOTE-${index + 1}`),
                      name:
                        it.name ||
                        it.product ||
                        newContext.product ||
                        "Quotation Item",
                      price: rate,
                      quantity: qty,
                      total,
                      size: it.size || "",
                      color: it.color || "",
                    };
                  })
                  .filter(Boolean);
              }

              if (!items.length) {
                const qty = Number(newContext.quantity || 0) || 0;
                const rate =
                  Number(
                    newContext.quotedRate ||
                    newContext.rate ||
                    newContext.pricePerUnit
                  ) || 0;
                let total = Number(newContext.total || 0);
                if (!total && qty && rate) {
                  total = qty * rate;
                }
                const finalQty = qty || 1;
                const finalTotal = total || rate * finalQty;
                items.push({
                  productId: String(newContext.productId || "QUOTE-1"),
                  name: newContext.product || "Custom Packaging",
                  price: rate || finalTotal,
                  quantity: finalQty,
                  total: finalTotal,
                  size: newContext.size || "",
                  color: newContext.color || "",
                });
              }

              let subtotal = items.reduce((sum, it) => sum + (Number(it.total) || 0), 0);
              if (Number(newContext.subtotal || 0) > 0) {
                subtotal = Number(newContext.subtotal);
              }

              let gst = Number(newContext.gst || 0);
              if (!gst && subtotal) {
                // GST Logic: 18% for Bulk Buyer + MDF products, else 5%
                const isBulkBuyer = session.userType === "Store Owner/ Bulk Buyer";
                const productName = (newContext.product || "").toLowerCase();
                const isMDF = productName.includes("mdf") || productName.includes("base");
                
                const gstRate = (isBulkBuyer && isMDF) ? 0.18 : 0.05;
                gst = Math.round(subtotal * gstRate);
              }

              let totalAmount =
                Number(newContext.total || newContext.totalAmount || 0) || 0;
              if (!totalAmount && subtotal) {
                totalAmount = subtotal + gst;
              }

              const now = new Date();
              const yy = String(now.getFullYear()).slice(-2);
              const base = `${yy}${now.getMonth() + 1}${now
                .getDate()
                .toString()
                .padStart(2, "0")}${now
                  .getHours()
                  .toString()
                  .padStart(2, "0")}${now
                    .getMinutes()
                    .toString()
                    .padStart(2, "0")}${now
                      .getSeconds()
                      .toString()
                      .padStart(2, "0")}`;
              const randomSuffix = Math.floor(Math.random() * 1000)
                .toString()
                .padStart(3, "0");
              const orderId = `QUO-${base}${randomSuffix}`;

              const customerName =
                (session.sales && session.sales.name) ||
                newContext.name ||
                "";
              const address = newContext.address || "";
              const pincode =
                newContext.pincode ||
                (session.sales && session.sales.pincode) ||
                "";

              const order = new Order({
                orderId,
                whatsapp: from,
                items,
                totalAmount,
                status: "PENDING",
                customerName,
                address,
                pincode,
              });
              await order.save();
              createdOrder = order;

              newContext.orderId = orderId;
              newContext.orderMongoId = order._id.toString();

              reply += `\n\n🆔 Quotation Reference ID: ${orderId}`;

              const adminNumbers = (process.env.ADMIN_WHATSAPP || "")
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean);
              if (adminNumbers.length > 0) {
                const lines = items.map((it, idx) => {
                  const sizePart = it.size ? `${it.size} – ` : "";
                  const qtyPart = `Qty ${it.quantity}`;
                  const ratePart =
                    it.price && !isNaN(it.price)
                      ? `× ₹${Number(it.price).toFixed(2)}`
                      : "";
                  const totalPart =
                    it.total && !isNaN(it.total)
                      ? `= ₹${Number(it.total).toFixed(2)}`
                      : "";
                  return `${idx + 1}) ${sizePart}${qtyPart} ${ratePart} ${totalPart}`.trim();
                });

                const adminMsg = `📢 Quotation Confirmed

🆔 Reference ID: ${orderId}
👤 Customer: ${customerName || "Unknown"}
📞 Phone: ${from}
🏙️ City: ${newContext.city || (session.sales && session.sales.city) || "Unknown"}

🛒 Items:
${lines.join("\n")}

💰 Total (incl. GST): ₹${totalAmount}

Please follow up with this confirmed quotation.`;

                for (const adminNum of adminNumbers) {
                  let target = adminNum;
                  if (!target.startsWith("whatsapp:")) {
                    target = "whatsapp:" + target;
                  }
                  try {
                    await sendAndLog(target, adminMsg);
                  } catch (err) {
                    console.error(
                      `Failed to send quotation confirmation to ${target}:`,
                      err.message
                    );
                  }
                }
              }
            }

            reply = reply.replace(
              /<CONTEXT_JSON>([\s\S]*?)<\/CONTEXT_JSON>/,
              ""
            ).trim();
          } catch (e) {
            console.error("Failed to parse context JSON from LLM:", e);
          }
        }

        // 5. Send Response
        // Use sendSplitMessage to handle long quotations safely
        await sendSplitMessage(from, reply);
        if (ragResponse.mediaUrls && ragResponse.mediaUrls.length > 0) {
          // Send first media if available
          await sendAndLog(from, "", { mediaUrl: ragResponse.mediaUrls[0] });
        }

        // 6. Admin Notification for Quotation
        if (reply.includes("📄 Quotation – Sachetan Packaging")) {
          const adminNumbers = (process.env.ADMIN_WHATSAPP || "").split(",").map(n => n.trim()).filter(Boolean);
          if (adminNumbers.length > 0) {
            const alertMsg = `📢 *New Quotation Generated!*
                 
👤 *Customer:* ${currentContext.name || "Unknown"}
📞 *Phone:* ${from}
🏙️ *City:* ${currentContext.city || "Unknown"}

${reply}

_Please follow up with this lead._`;

            // Append User Media to Admin Alert if available
            if (currentContext.mediaUrl) {
              alertMsg += `\n\n📷 *User Media:* ${currentContext.mediaUrl}`;
            }

            for (const adminNum of adminNumbers) {
              let target = adminNum;
              if (!target.startsWith("whatsapp:")) target = "whatsapp:" + target;
              try {
                await sendAndLog(target, alertMsg);
              } catch (err) {
                console.error(`Failed to send admin alert to ${target}:`, err.message);
              }
            }
          }
        }

        // 7. Update DB
        session.context = newContext;
        await mysqlPool.query("UPDATE tbl_chat_sessions SET context = ?, last_message_at = NOW() WHERE phone = ?", [JSON.stringify(newContext), from]);

      } catch (err) {
        console.error("Error in custom_solutions AI:", err);
        await sendAndLog(from, "I'm having a bit of trouble connecting to my brain right now. 🧠\nPlease try again in a moment!");
      }

      return;
    }

    if (session.stage === "menu") {
      if (body === "1" || body.includes("buy") || body.includes("product")) {
        session.stage = "shop_top_category";
        const [topCats] = await mysqlPool.query(
          "SELECT `tcat_id`,`tcat_name` FROM `tbl_top_category` ORDER BY `tcat_name` ASC"
        );
        if (!topCats.length) {
          await sendAndLog(
            from,
            "No categories available. Please try again later."
          );
          return res.end();
        }
        session.topCats = topCats;
        let msg = "🛒 *Select a Top Category:*\n\n";
        topCats.forEach((c, i) => {
          msg += `*${i + 1}️⃣ ${c.tcat_name}*\n`;
        });
        msg += "\nReply with the number.";
        await sendAndLog(from, msg);
        return res.end();
      } else if (
        body === "2" ||
        body.includes("solutions") ||
        body.includes("custom")
      ) {
        session.stage = "select_user_type";
        await sendAndLog(
          from,
          `👋 Hi! Welcome to *Sachetan Packaging* 😊
We offer *customized packaging solutions* just for you!

👇 *Please select your business type:*

*1️⃣ Homebakers*
*2️⃣ Store Owner/ Bulk Buyer*
*3️⃣ Sweet Shop Owner*

_Reply with a number to proceed._`,
          { contentSid: process.env.TWILIO_CONTENT_SID_USER_TYPE }
        );
        return res.end();
      } else if (body === "3" || body.includes("support") || body.includes("faq")) {
        const supportBody = `🏢 *Contact & Support*

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

Reply 'menu' to return to main menu.`;

        const options = {};
        if (process.env.TWILIO_CONTENT_SID_SUPPORT) {
          options.contentSid = process.env.TWILIO_CONTENT_SID_SUPPORT;
        }

        await sendAndLog(from, supportBody, options);
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
        await sendAndLog(from, dateOptions);
        return res.end();
      } else if (body === "my bookings") {
        const bookings = await Booking.find({ whatsapp: from });
        if (!bookings.length) {
          await sendAndLog(
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
          await sendAndLog(from, text);
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
        await sendAndLog(from, dateOptions);
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

        await sendAndLog(from, pricingInfo);
        return res.end();
      } else if (body.includes("contact") || body.includes("admin")) {
        await sendAndLog(
          from,
          `🏢 *Contact & Support*

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

Reply 'menu' to return to main menu.`
        );
        return res.end();
      } else if (
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
        await sendAndLog(
          from,
          `🧰 *Sachetan Packaging*

*1️⃣ Buy Products* - Browse categories and order
*2️⃣ Custom Solutions* - Get personalized packaging
*3️⃣ FAQ & Support* - Help and contact

Reply with a number or option name.`
        );
        return res.end();
      } else {
        // Fallback to AI for any text that isn't a menu command
        // Check if it's a greeting/menu command that wasn't caught by the top handler (shouldn't happen with updated lists)
        // but just in case, we redirect to menu logic if it looks like one.
        const lowerBody = body.toLowerCase();
        if (
          lowerBody === "hi" || lowerBody === "hello" || lowerBody === "menu" || lowerBody === "start" ||
          lowerBody.includes("menu") || lowerBody.includes("thank")
        ) {
          // Redirect to menu logic by setting session and re-processing (or just sending menu directly)
          // Here we just send the menu to be safe
          await sendAndLog(
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
*2️⃣ Custom Solutions* - Product Queries  
*3️⃣ FAQ & Support* - Contact Us  
        _Reply with a number to proceed._`,
            { contentSid: process.env.TWILIO_CONTENT_SID_SERVICES }
          );
          return res.end();
        }

        try {
          // Strict filtering by user type if selected
          const filter = session.userType ? { type: session.userType } : {};
          // Use strict mode if userType is selected to avoid Tavily/outside context
          const strict = !!session.userType;

          const result = await queryRag(body, 4, undefined, filter, strict);
          let answer = result.answer;

          // If strict mode and answer indicates failure, prompt to re-initiate
          if (strict && (
            !answer ||
            answer.includes("I'm not sure") ||
            answer.includes("couldn't find information") ||
            !result.context // If no context found in strict mode
          )) {
            await sendAndLog(from, `I couldn't find specific information for *${session.userType}* regarding your query.

However, our support team is ready to help you!

📞 *Call us:* +91 92263 22231 / +91 84460 22231
📧 *Email:* sagar9994@rediffmail.com
🌐 *Website:* https://sachetanpackaging.in

Would you like to search in another category?

👇 *Please select your business type:*

*1️⃣ Homebakers*
*2️⃣ Store Owner/ Bulk Buyer*
*3️⃣ Sweet Shop Owner*

_Reply with a number to proceed._`);

            // Reset stage to allow selection
            session.stage = "select_user_type";
            return res.end();
          }

          if (!answer) answer = "I'm not sure about that. Reply 'menu' to see options.";

          await sendAndLog(from, answer);
          if (result.mediaUrls && result.mediaUrls.length > 0) {
            for (const mediaUrl of result.mediaUrls) {
              await sendAndLog(from, "", { mediaUrl });
            }
          }

          // Optional: save to memory
          try {
            const { upsertDocuments } = require("../utils/rag");
            await upsertDocuments(
              [
                {
                  id: `q_${Date.now()}`,
                  text: `Q: ${body}\nA: ${result.answer || ""}`,
                  metadata: { source: "chat", user: from },
                },
              ],
              "customer_memory"
            );
          } catch { }
        } catch (e) {
          await sendAndLog(
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
        session.stage = "custom_solutions";
        // We can treat the pending question as the input for AI immediately
        const question = session.pendingQuestion;
        delete session.pendingQuestion;
        delete session.previousStage;

        // Process AI request immediately
        try {
          const result = await queryRag(question);
          await sendAndLog(
            from,
            result.answer || "No answer available right now."
          );
          try {
            const { upsertDocuments } = require("../utils/rag");
            await upsertDocuments(
              [
                {
                  id: `q_${Date.now()}`,
                  text: `Q: ${question}\nA: ${result.answer || ""}`,
                  metadata: { source: "chat", user: from },
                },
              ],
              "customer_memory"
            );
          } catch { }
        } catch (e) {
          await sendAndLog(
            from,
            "⚠️ Oops! Our assistant is taking a short break. Please try again in a few moments - we’ll be right back to help you 😊"
          );
        }
        return res.end();
      } else {
        // User wants to stay in flow
        session.stage = session.previousStage;
        delete session.pendingQuestion;
        delete session.previousStage;
        await sendAndLog(
          from,
          "Okay, continuing with your order. Please make a selection."
        );
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
          await sendAndLog(
            from,
            `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`,
            {
              buttons: [
                { id: "yes", text: "Yes, ask Custom Solutions" },
                { id: "no", text: "No, continue order" },
              ],
            }
          );
          return res.end();
        }
        await sendAndLog(
          from,
          "Invalid selection. Reply with the category number."
        );
        return res.end();
      }
      const selectedTop = cats[idx - 1];
      session.selectedTop = selectedTop;
      const [midCats] = await mysqlPool.query(
        "SELECT `mcat_id`,`mcat_name` FROM `tbl_mid_category` WHERE `tcat_id`=? ORDER BY `mcat_name` ASC",
        [selectedTop.tcat_id]
      );
      if (!midCats.length) {
        await sendAndLog(
          from,
          "No subcategories in this category. Reply 'menu' to go back."
        );
        session.stage = "menu";
        return res.end();
      }
      session.midCats = midCats;
      session.stage = "shop_mid_category";
      let msg = `📂 *${selectedTop.tcat_name}*\n\nSelect a subcategory:\n\n`;
      midCats.forEach((c, i) => {
        msg += `*${i + 1}️⃣ ${c.mcat_name}*\n`;
      });
      msg += "\nReply with the number.";
      await sendAndLog(from, msg);
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
          await sendAndLog(
            from,
            `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`,
            {
              buttons: [
                { id: "yes", text: "Yes, ask AI" },
                { id: "no", text: "No, continue order" },
              ],
            }
          );
          return res.end();
        }
        await sendAndLog(
          from,
          "Invalid selection. Reply with the subcategory number."
        );
        return res.end();
      }
      const selectedMid = cats[idx - 1];
      session.selectedMid = selectedMid;

      // Direct Product Fetch (Skipping End Category)
      const [products] = await mysqlPool.query(
        `
        SELECT p.p_id, p.p_name, p.p_current_price, p.p_old_price, p.p_description, p.p_featured_photo 
        FROM tbl_product p
        JOIN tbl_end_category ec ON p.ecat_id = ec.ecat_id
        WHERE ec.mcat_id = ?
        ORDER BY p.p_name ASC
      `,
        [selectedMid.mcat_id]
      );

      if (!products.length) {
        await sendAndLog(
          from,
          "No products in this category. Reply 'menu' to go back."
        );
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
      await sendAndLog(from, msg);
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
          await sendAndLog(
            from,
            `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`,
            {
              buttons: [
                { id: "yes", text: "Yes, ask AI" },
                { id: "no", text: "No, continue order" },
              ],
            }
          );
          return res.end();
        }
        await sendAndLog(
          from,
          "Invalid selection. Reply with the product number, or 'menu' to go back."
        );
        return res.end();
      }
      const product = products[idx - 1];
      session.selectedProduct = product;

      // Fetch extra details (sizes, colors)
      const [sizes] = await mysqlPool.query(
        "SELECT s.size_name FROM tbl_size s JOIN tbl_product_size ps ON s.size_id=ps.size_id WHERE ps.p_id=?",
        [product.p_id]
      );
      const [colors] = await mysqlPool.query(
        "SELECT c.color_name FROM tbl_color c JOIN tbl_product_color pc ON c.color_id=pc.color_id WHERE pc.p_id=?",
        [product.p_id]
      );

      product.sizes = sizes.map((s) => s.size_name).join(", ");
      product.colors = colors.map((c) => c.color_name).join(", ");

      session.stage = "shop_quantity";

      const oldPriceDisplay =
        product.p_old_price > product.p_current_price
          ? `\n❌ Old Price: ~₹${product.p_old_price}~`
          : "";
      const sizeDisplay = product.sizes ? `\n📏 Size: ${product.sizes}` : "";
      const colorDisplay = product.colors
        ? `\n🎨 Color: ${product.colors}`
        : "";

      const cleanDesc = stripHtml(product.p_description);
      const descDisplay = cleanDesc
        ? `\n📝 Description: ${cleanDesc.substring(0, 150)}${cleanDesc.length > 150 ? "..." : ""
        }`
        : "";

      const imageUrl = product.p_featured_photo
        ? `https://www.sachetanpackaging.in/assets/uploads/${product.p_featured_photo}`
        : null;

      const packSize = 20;
      const unitPrice =
        product.p_current_price && packSize
          ? (product.p_current_price / packSize).toFixed(2)
          : product.p_current_price;

      const mediaOptions = await getSafeMediaPayload(imageUrl);

      await sendAndLog(
        from,
        `📦 *${product.p_name}*
──────────────────
💰 *Pack Price (20 pcs): ₹${product.p_current_price}*${oldPriceDisplay}
🧮 *Price per piece:* ₹${unitPrice}${sizeDisplay}${colorDisplay}${descDisplay}

👉 *Reply with Quantity (20 or more)* to proceed.
Minimum order: 20 pieces
_Reply 'menu' to go back._`,
        mediaOptions
      );
      return res.end();
    }

    if (session.stage === "shop_quantity") {
      const packSize = 20;
      const qty = parseInt(body, 10);
      if (isNaN(qty) || qty < packSize) {
        if (isConversational(body)) {
          session.previousStage = session.stage;
          session.pendingQuestion = body;
          session.stage = "confirm_exit_flow";
          await sendAndLog(
            from,
            `⚠️ You are currently ordering. Do you want to cancel and ask: "${body}"?`,
            {
              buttons: [
                { id: "yes", text: "Yes, ask AI" },
                { id: "no", text: "No, continue order" },
              ],
            }
          );
          return res.end();
        }
        await sendAndLog(
          from,
          `Invalid quantity. Please enter a valid quantity of ${packSize} or more.`
        );
        return res.end();
      }
      const product = session.selectedProduct;
      const unitPrice =
        product.p_current_price && packSize
          ? product.p_current_price / packSize
          : product.p_current_price || 0;
      const total = unitPrice * qty;

      // Prepare item with full details
      const item = {
        productId: product.p_id,
        name: product.p_name,
        price: product.p_current_price,
        quantity: qty,
        total,
        oldPrice: product.p_old_price,
        size: product.sizes, // String like "Small, Medium"
        color: product.colors, // String like "Red, Blue"
        // dimensions/weight if available in product object
      };

      session.context = session.context || {};
      session.context.orderDraft = {
        items: [item],
        totalAmount: total,
      };

      // Ask for Customer Details
      session.stage = "ask_name";
      await mysqlPool.query("UPDATE tbl_chat_sessions SET stage = ?, context = ?, last_message_at = NOW() WHERE phone = ?", ["ask_name", JSON.stringify(session.context), from]);

      await sendAndLog(from, "👤 *Please enter your Full Name:*");
      return res.end();
    }

    if (session.stage === "ask_name") {
      if (isConversational(body)) {
        // Handle interruption if needed, but for name, almost anything is valid.
        // However, if they type "menu" or "cancel", it's handled by generic logic if we had it,
        // but here we check specifically.
        if (
          body.toLowerCase() === "menu" ||
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
          body.toLowerCase() === "Thank you for confirming my booking."
        ) {
          session.stage = "menu";
          await sendAndLog(
            from,
            "Order cancelled. Reply 'menu' to see options."
          );
          return res.end();
        }
      }

      const draft = session.context.orderDraft || session.orderDraft;
      if (!draft) {
        // Recover if lost, or reset
        session.stage = "menu";
        await sendAndLog(from, "Session expired. Please start order again. Reply 'menu'.");
        return res.end();
      }
      draft.customerName = body;
      session.context.orderDraft = draft;
      session.stage = "ask_address";
      await mysqlPool.query("UPDATE tbl_chat_sessions SET stage = ?, context = ?, last_message_at = NOW() WHERE phone = ?", ["ask_address", JSON.stringify(session.context), from]);

      await sendAndLog(from, "📍 *Please enter your Delivery Address:*");
      return res.end();
    }

    if (session.stage === "ask_address") {
      const draft = session.context.orderDraft || session.orderDraft;
      if (!draft) {
        session.stage = "menu";
        await sendAndLog(from, "Session expired. Please start order again. Reply 'menu'.");
        return res.end();
      }
      draft.address = body;
      session.context.orderDraft = draft;
      session.stage = "ask_pincode";
      await mysqlPool.query("UPDATE tbl_chat_sessions SET stage = ?, context = ?, last_message_at = NOW() WHERE phone = ?", ["ask_pincode", JSON.stringify(session.context), from]);

      await sendAndLog(from, "📮 *Please enter your Pincode:*");
      return res.end();
    }

    if (session.stage === "ask_pincode") {
      const draft = session.context.orderDraft || session.orderDraft;
      if (!draft) {
        session.stage = "menu";
        await sendAndLog(from, "Session expired. Please start order again. Reply 'menu'.");
        return res.end();
      }
      draft.pincode = body;
      session.context.orderDraft = draft;
      session.stage = "shop_confirm";
      await mysqlPool.query("UPDATE tbl_chat_sessions SET stage = ?, context = ?, last_message_at = NOW() WHERE phone = ?", ["shop_confirm", JSON.stringify(session.context), from]);

      const item = draft.items[0]; // Currently single item flow

      await sendAndLog(
        from,
        `🧾 *Order Summary*
        
• *${item.name}*
  Qty: ${item.quantity}
  Price: ₹${item.price}
  Total: ₹${item.total}
  ${item.size ? `Size: ${item.size}` : ""}
  ${item.color ? `Color: ${item.color}` : ""}

*Customer Details:*
👤 Name: ${draft.customerName}
📍 Address: ${draft.address}
📮 Pincode: ${draft.pincode}

*Grand Total: ₹${draft.totalAmount}*`,
        {
          buttons: [
            { id: "confirm", text: "Confirm Order" },
            { id: "menu", text: "Cancel Order" },
          ],
          contentSid: process.env.TWILIO_CONTENT_SID_CONFIRM,
          contentVariables: {
            1: item.name,
            2: String(item.quantity),
            3: String(item.price),
            4: String(item.total),
            5: item.size ? `Size: ${item.size}` : "",
            6: item.color ? `Color: ${item.color}` : "",
            7: draft.customerName,
            8: draft.address,
            9: draft.pincode,
            10: String(draft.totalAmount),
          },
        }
      );
      return res.end();
    }

    if (session.stage === "shop_confirm") {
      if (body === "1" || body === "confirm" || body.includes("confirm")) {
        const draft = session.context.orderDraft || session.orderDraft;
        if (!draft) {
          session.stage = "menu";
          await sendAndLog(from, "Session expired. Please start order again. Reply 'menu'.");
          return res.end();
        }
        const orderId = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(
          Math.random() * 1000
        )}`;
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
        const payUrl = `${process.env.BASE_URL || "http://localhost:4000"
          }/payment/product?order=${order._id}`;
        await sendAndLog(
          from,
          `💳 *Payment Link Generated*
Order ID: ${orderId}
Amount: ₹${draft.totalAmount}

Click to pay:
${payUrl}

_Link expires in 5 minutes._
Reply 'menu' to return.`,
          {
            buttons: [{ id: "menu", text: "Main Menu" }],
            // Use 'used contentsid main menu button' (assuming placeholder or same SID if applicable, but usually distinct)
            // Since no explicit SID provided for Payment Link, we use a placeholder or reuse if appropriate.
            // Based on user input "used contentsid main menu button", we'll assume they want to use a specific SID they provided before
            // or they mean the "Main Menu" SID is NOT for this.
            // Actually, "used contentsid main menu button" likely refers to the Main Menu SID 'HX7d5236227e75996966c466fb55ef1434'
            // but that template probably doesn't have 4 variables and a CTA.
            // We will use a placeholder process.env.TWILIO_CONTENT_SID_PAYMENT
            contentSid: process.env.TWILIO_CONTENT_SID_PAYMENT,
            contentVariables: {
              1: orderId,
              2: String(draft.totalAmount),
              3: "5", // Expiration minutes
              4: order._id.toString(), // Dynamic part of the URL
            },
          }
        );
        session.stage = "menu";
        await mysqlPool.query("UPDATE tbl_chat_sessions SET stage = 'menu', last_message_at = NOW() WHERE phone = ?", [from]);

        try {
          const { upsertDocuments } = require("../utils/rag");
          await upsertDocuments(
            [
              {
                id: `order_${order._id}`,
                text: `Order created: ${JSON.stringify(order.toObject())}`,
                metadata: { source: "order", user: from },
              },
            ],
            "customer_memory"
          );
        } catch { }
        return res.end();
      } else if (
        body === "menu" ||
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
        body === "good night"
      ) {
        session.stage = "menu";
        await sendAndLog(
          from,
          "Order cancelled. Reply 'menu' to see options."
        );
        return res.end();
      } else {
        await sendAndLog(
          from,
          "Reply 'confirm' to proceed or 'menu' to cancel."
        );
        return res.end();
      }
    }


    // --- Lead Capture Stages ---
    if (session.stage === "custom_solutions_ask_name") {
      if (
        body === "menu" ||
        body === "cancel" ||
        body === "exit"
      ) {
        session.stage = "menu";
        await sendAndLog(from, "Cancelled. Reply 'menu' to see options.");
        return res.end();
      }

      session.sales = session.sales || {};
      session.sales.name = (req.body.Body || "").trim();
      session.stage = "custom_solutions_ask_city";
      await sendAndLog(from, "Thanks! Which city are you from?");
      return res.end();
    }

    if (session.stage === "custom_solutions_ask_city") {
      if (
        body === "menu" ||
        body === "cancel" ||
        body === "exit"
      ) {
        session.stage = "menu";
        await sendAndLog(from, "Cancelled. Reply 'menu' to see options.");
        return res.end();
      }

      session.sales.city = (req.body.Body || "").trim();
      session.stage = "custom_solutions_ask_pincode";
      await sendAndLog(from, "Got it. And your Pincode?");
      return res.end();
    }

    if (session.stage === "custom_solutions_ask_pincode") {
      if (
        body === "menu" ||
        body === "cancel" ||
        body === "exit"
      ) {
        session.stage = "menu";
        await sendAndLog(from, "Cancelled. Reply 'menu' to see options.");
        return res.end();
      }

      session.sales.pincode = (req.body.Body || "").trim();
      session.stage = "custom_solutions";

      await sendAndLog(from, "✅ Thanks! We have updated your profile.\n\nHow else can I help you today?");

      // Log complete lead
      try {
        await logLead({
          phone: from,
          name: session.sales.name,
          city: session.sales.city,
          pincode: session.sales.pincode,
          product: "Profile Update",
          size: "",
          paper: "",
          quantity: "",
          printing: "",
          notes: "User provided full details via chat flow",
          converted: true,
        });
      } catch (e) {
        console.error("Error logging lead:", e);
      }
      return res.end();
    }
    // ---------------------------

    if (session.stage === "custom_solutions") {
      const question = (req.body.Body || "").trim();
      session.sales = session.sales || {
        askedNameCity: false,
        leadLogged: false,
      };
      function extractSpecs(t) {
        const s = t.toLowerCase();
        let product = "";
        if (/cake box|cakebox|cake\s*box/.test(s)) product = "Cake Box";
        else if (/pizza box|pizza\s*box/.test(s)) product = "Pizza Box";
        else if (/paper bag|bag/.test(s)) product = "Paper Bag";
        else if (/base|cake base|board/.test(s)) product = "Base";
        else if (/laminated box/.test(s)) product = "Laminated Box";
        const sizeMatch =
          s.match(/(\d+)\s*kg/) || s.match(/size\s*[:\-]\s*([^\n]+)/);
        const size = sizeMatch ? sizeMatch[1] || sizeMatch[0] : "";
        const qtyMatch =
          s.match(/(\d{2,})\s*(qty|pcs|pieces|quantity)/) ||
          s.match(/quantity\s*[:\-]\s*(\d{2,})/);
        const quantity = qtyMatch ? qtyMatch[1] || "" : "";
        const gsmMatch = s.match(/(\d{2,4})\s*gsm/);
        const paper = gsmMatch ? `${gsmMatch[1]} GSM` : "";
        const printing = /print|printed|logo|branding|custom/.test(s)
          ? toLowerCase("Yes")
          : "";
        return { product, size, paper, quantity, printing };
      }
      function extractNameCity(t, askedHint) {
        const s = (t || "").trim().replace(/\s+/g, " ");
        // Blocklist for common non-name words
        const blocklist = ["give", "send", "show", "want", "need", "buy", "order", "price", "cost", "how", "what", "where", "when", "cake", "box", "bag", "base", "image", "pic", "picture", "pdf", "file", "of", "the", "and", "for", "with", "name", "is", "my", "i", "am"];

        const isValidName = (n) => {
          if (!n || n.length < 2) return false;
          const words = n.split(" ");
          if (words.length > 3) return false;
          if (words.some(w => blocklist.includes(w.toLowerCase()))) return false;
          return /^[a-zA-Z ]+$/.test(n);
        };

        const isValidCity = (c) => {
          if (!c || c.length < 2) return false;
          if (blocklist.includes(c.toLowerCase())) return false;
          return /^[a-zA-Z ]+$/.test(c);
        };

        let name = null, city = null;
        let m;

        m = s.match(/name\s*[:\-]\s*([a-zA-Z ]{2,})/i);
        if (m && isValidName(m[1].trim())) name = m[1].trim();

        m = s.match(/\bcity\s*[:\-]\s*([a-zA-Z ]{2,})/i);
        if (m && isValidCity(m[1].trim())) city = m[1].trim();

        m = s.match(/my name is\s+([a-zA-Z ]{2,})/i);
        if (!name && m && isValidName(m[1].trim())) name = m[1].trim();

        m = s.match(/i am\s+([a-zA-Z ]{2,})/i);
        if (!name && m && isValidName(m[1].trim())) name = m[1].trim();

        m = s.match(/\bfrom\s+([a-zA-Z ]{2,})/i);
        if (!city && m && isValidCity(m[1].trim())) city = m[1].trim();

        if (askedHint && !name && !city) {
          const tokens = s.split(" ");
          if (tokens.length >= 2) {
            const cityCandidate = tokens[tokens.length - 1];
            const nameCandidate = tokens.slice(0, -1).join(" ");

            if (isValidName(nameCandidate) && isValidCity(cityCandidate)) {
              name = nameCandidate;
              city = cityCandidate;
            }
          }
        }
        return { name, city };
      }
      const nc = extractNameCity(question, session.sales.askedNameCity);
      if (nc.name) session.sales.name = nc.name;
      if (nc.city) session.sales.city = nc.city;

      // Exit command
      if (
        question.toLowerCase() === "main menu" ||
        question.toLowerCase() === "exit" ||
        question.toLowerCase() === "menu" ||
        question.toLowerCase() === "back" ||
        question.toLowerCase() === "home" ||
        question.toLowerCase() === "exit" ||
        question.toLowerCase() === "end" ||
        question.toLowerCase() === "stop" ||
        question.toLowerCase() === "reset" ||
        question.toLowerCase() === "thanks" ||
        question.toLowerCase() === "thank you" ||
        question.toLowerCase() === "thankyou" ||
        question.toLowerCase() === "thx" ||
        question.toLowerCase() === "ty" ||
        question.toLowerCase() === "thank u" ||
        question.toLowerCase() === "ok" ||
        question.toLowerCase() === "okay" ||
        question.toLowerCase() === "cool" ||
        question.toLowerCase() === "done" ||
        question.toLowerCase() === "confirmed" ||
        question.toLowerCase() === "yes" ||
        question.toLowerCase() === "yep" ||
        question.toLowerCase() === "yo" ||
        question.toLowerCase() === "good morning" ||
        question.toLowerCase() === "good evening" ||
        question.toLowerCase() === "good night"
      ) {
        session.stage = "menu";
        await sendAndLog(
          from,
          `🧰 *Sachetan Packaging*
          
*1️⃣ Buy Products*
*2️⃣ Order Status*
*3️⃣ Custom Solutions*
*4️⃣ FAQ & Support*

Reply with a number.`
        );
        return res.end();
      }

      try {
        const filter = session.userType ? { type: { $in: [session.userType, "all"] } } : {};
        const result = await queryRag(question, 4, undefined, filter);
        let reply = result.answer || "No answer available right now.";

        await sendAndLog(from, reply);

        // Enhanced Image Matching & Fallback Logic
        const isAskingForImage = /image|photo|pic|show|see|look|design|demo|sample/i.test(question);

        if (result.mediaUrls && result.mediaUrls.length > 0) {
          session.sentMediaUrls = session.sentMediaUrls || new Set();

          // Extract significant terms from user query for filename matching
          const stopWords = ["i", "want", "need", "show", "me", "images", "photos", "pics", "of", "the", "a", "an", "for", "in", "is", "are", "please", "can", "you", "give", "send"];
          const queryTerms = question.toLowerCase()
            .replace(/[^\w\s]/g, "") // remove punctuation
            .split(/\s+/)
            .filter(w => !stopWords.includes(w) && w.length > 2);

          let mediaToSend = [];

          if (queryTerms.length > 0) {
            // Try to find specific matches in filenames
            const matches = result.mediaUrls.filter(url => {
              const filename = url.split("/").pop().toLowerCase();
              return queryTerms.some(term => filename.includes(term));
            });

            if (matches.length > 0) {
              mediaToSend = matches;
            } else if (isAskingForImage) {
              // Specific request ("cake base") but no filename match found in RAG results
              await sendAndLog(from, `I don't have a specific demo image for *"${queryTerms.join(" ")}"* handy right now.
                  
However, our support team can share photos with you!
📞 *Call/WhatsApp:* +91 92263 22231
📧 *Email:* sagar9994@rediffmail.com

_Please continue, I can still help with pricing and details!_`);
            } else {
              // User didn't explicitly ask for image, and no specific match found.
              // Optionally send nothing, or send all? 
              // If RAG thought they were relevant, maybe we send them anyway if confidence is high?
              // For now, let's be conservative to avoid spamming irrelevant images.
              // But if query was "prices for box", RAG might return box images.
              // Let's send all if no specific terms conflicted? 
              // No, user wants "as per selection type product give image".
              // So strict matching is preferred.
              // If no strict match, we don't send media.
            }
          } else {
            // Generic request ("show me images"), send all available from context
            mediaToSend = result.mediaUrls;
          }

          for (const mediaUrl of mediaToSend) {
            const url = String(mediaUrl || "").trim();
            if (url && !session.sentMediaUrls.has(url)) {
              await sendAndLog(from, "", { mediaUrl: url });
              session.sentMediaUrls.add(url);
            }
          }
        } else if (isAskingForImage) {
          // User asked for image, but RAG returned none
          await sendAndLog(from, `I currently don't have a demo image for that available here.

You can contact our support for specific photos:
📞 +91 92263 22231

_Is there anything else I can help you with?_`);
        }

        await logConversation({
          phone: from,
          name: session.sales.name || "",
          city: session.sales.city || "",
          stage: "custom_solutions",
          message: question,
          reply: result.mediaUrls && result.mediaUrls.length > 0 ? `${reply} [Media: ${result.mediaUrls.join(", ")}]` : reply,
        });
        const isLeadIntent =
          /quote|quotation|order|buy|price|bulk|custom|printed|logo|branding/i.test(
            question
          );
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
        } else if (
          session.sales.name &&
          session.sales.city &&
          !session.sales.leadLogged
        ) {
          await logLead({
            phone: from,
            name: session.sales.name,
            city: session.sales.city,
            product: "",
            size: "",
            paper: "",
            quantity: "",
            printing: "",
            notes: question,
            converted: false,
          });
          session.sales.leadLogged = true;
        }
        // Suggest user type selection based on matched metadata if none selected
        if (!session.userType) {
          const types = (result.matches || [])
            .map(m => (m.metadata && m.metadata.type) ? String(m.metadata.type) : "")
            .filter(t => t && t.toLowerCase() !== "all");
          const uniqueTypes = Array.from(new Set(types));
          // Heuristic: if we have a dominant single type in matches, prompt selection
          if (uniqueTypes.length === 1) {
            const suggestedType = uniqueTypes[0];
            session.stage = "select_user_type";
            await sendAndLog(
              from,
              `I found relevant results under *${suggestedType}*.\n\nSelect your business type to get precise pricing and product details:`,
              { contentSid: process.env.TWILIO_CONTENT_SID_USER_TYPE }
            );
            return res.end();
          }
        }
        // If user asked for MDF cake bases and current type likely mismatches, suggest switching
        const mdfIntent = /mdf|cake\s*base|gold\s*base|board/i.test(question);
        if (mdfIntent && session.userType && session.userType !== "Store Owner/ Bulk Buyer") {
          const matchTypes = (result.matches || [])
            .map(m => (m.metadata && m.metadata.type) ? String(m.metadata.type) : "")
            .filter(Boolean);
          const hasStoreOwnerData = matchTypes.includes("Store Owner/ Bulk Buyer");
          if (hasStoreOwnerData || !result.context) {
            session.stage = "select_user_type";
            await sendAndLog(
              from,
              `This item is available in *Store Owner/ Bulk Buyer* catalog.\n\nSwitch your business type to view MDF cake base details and pricing:`,
              { contentSid: process.env.TWILIO_CONTENT_SID_USER_TYPE }
            );
            return res.end();
          }
        }
        // Ask for details if missing
        if (!session.sales.askedDetails) {
          if (!session.sales.name) {
            session.sales.askedDetails = true;
            session.stage = "custom_solutions_ask_name";
            await sendAndLog(from, "To serve you better, may I know your Full Name?");
          } else if (!session.sales.city) {
            session.sales.askedDetails = true;
            session.stage = "custom_solutions_ask_city";
            await sendAndLog(from, `Thanks ${session.sales.name}! Which city are you from?`);
          } else if (!session.sales.pincode) {
            session.sales.askedDetails = true;
            session.stage = "custom_solutions_ask_pincode";
            await sendAndLog(from, "Could you please share your Pincode for delivery check?");
          }
        }
        try {
          const { upsertDocuments } = require("../utils/rag");
          await upsertDocuments(
            [
              {
                id: `q_${Date.now()}`,
                text: `Q: ${question}\nA: ${result.answer || ""}`,
                metadata: { source: "chat", user: from },
              },
            ],
            "customer_memory"
          );
        } catch { }
      } catch (e) {
        await sendAndLog(
          from,
          "⚠️ Oops! Our assistant is taking a short break. Please try again in a few moments - we’ll be right back to help you 😊"
        );
      }
      // Stay in custom_solutions stage
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
        await sendAndLog(
          from,
          "❌ Invalid date selection. Please reply with a number from the list."
        );
        return res.end();
      }

      const selectedDate = availableDates[idx - 1].value;
      const slots = await Slot.find();
      const courts = await Court.find();

      // In the check_availability_date stage
      let availabilityMsg = `💸 Available time slots for ${availableDates[idx - 1].display
        }:\n\n`;

      if (!slots.length || !courts.length) {
        availabilityMsg =
          "No time slots or courts configured. Please try another date or contact admin.";
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
          availabilityMsg =
            "No available time slots for this date. Please select another date.";
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

          availabilityMsg =
            currentChunk +
            "\nReply with 'book' to make a booking or 'menu' to return to main menu.";
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
        await sendAndLog(from, dateOptions);
        return res.end();
      } else if (
        body === "menu" ||
        body.includes("menu") ||
        body.includes("main menu") ||
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
        await sendAndLog(
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
        await sendAndLog(
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
        await sendAndLog(
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

      await sendAndLog(from, playerOptions);
      return res.end();
    }

    if (session.stage === "choose_players") {
      const playerCount = parseInt(body);
      if (isNaN(playerCount) || playerCount < 2 || playerCount > 4) {
        await sendAndLog(
          from,
          "❌ Invalid player count. Please reply with 2, 3, or 4 players."
        );
        return res.end();
      }

      session.draft.playerCount = playerCount;

      const slots = await Slot.find({ status: "Active" });
      if (!slots.length) {
        await sendAndLog(from, "No slots configured. Contact admin.");
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
        await sendAndLog(
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
      await sendAndLog(from, msg);
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

        await sendAndLog(from, playerOptions);
        return res.end();
      } else if (
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
        await sendAndLog(
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
        await sendAndLog(
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

        await sendAndLog(from, playerOptions);
        return res.end();
      }

      const idx = parseInt(body);
      const slots = session.slots || [];
      if (isNaN(idx) || idx < 1 || idx > slots.length) {
        await sendAndLog(
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
        await sendAndLog(
          from,
          "No courts available for this time slot. Please select another time slot."
        );
        session.stage = "choose_slot";
        return res.end();
      }

      let msg = `🎾 Available courts for ${session.draft.dateDisplay} – ${session.draft.slot} (${session.draft.playerCount} players):\n\n`;
      availableCourts.forEach((c, i) => {
        const courtAmount = calculateAmount(
          session.draft.duration,
          session.draft.playerCount
        );
        msg += `*${i + 1}. ${c.name}* - ₹${courtAmount} (${session.draft.duration
          })\n`;
      });
      msg += "\nReply with the court number.";
      msg += "\nReply 'back' to choose different time slot.";

      session.courts = availableCourts;
      session.stage = "choose_court";
      await sendAndLog(from, msg);
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
        await sendAndLog(from, msg);
        return res.end();
      }

      const idx = parseInt(body);
      const courts = session.courts || [];
      if (isNaN(idx) || idx < 1 || idx > courts.length) {
        await sendAndLog(
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

      await sendAndLog(from, summary);
      return res.end();
    }

    if (session.stage === "payment_pending") {
      if (body.includes("paid")) {
        const booking = await Booking.findById(session.bookingId);
        if (!booking) {
          await sendAndLog(from, "Booking not found.");
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
          await sendAndLog(
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

        await sendAndLog(
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
          await sendAndLog(
            from,
            "❌ Booking cancelled successfully. If your payment was successful for this cancelled booking, please contact our support team for a refund. Reply 'menu' to return to main menu."
          );
        } else {
          await sendAndLog(
            from,
            "Booking not found. Reply 'menu' to return to main menu."
          );
        }
        delete sessions[from];
        return res.end();
      } else if (body === "menu") {
        session.stage = "menu";
        await sendAndLog(
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
        await sendAndLog(
          from,
          "Please reply with 'cancel' to cancel your booking, or 'menu' to return to the main menu."
        );
        return res.end();
      }
    }

    if (session.stage === "booking_confirmed") {
      if (body === "menu") {
        session.stage = "menu";
        await sendAndLog(
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
        await sendAndLog(
          from,
          "Please reply with 'menu' to return to main menu."
        );
        return res.end();
      }
    }

    // Default fallback
    await sendAndLog(
      from,
      "Sorry, I didn't understand. Reply 'hi' to restart or 'menu' to see options."
    );
    res.end();
  } catch (error) {
    console.error("Error in Twilio webhook:", error);
    const phoneNumber = req.body.From || "unknown";
    try {
      await sendAndLog(
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
