const twilio = require("twilio");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Send a WhatsApp message. Supports text, media, and interactive buttons (via Content API or fallback).
 * @param {string} to - Recipient phone number
 * @param {string} body - Message body (fallback text)
 * @param {Object} options - Additional options
 * @param {Array} options.buttons - Array of button objects {id, text} for fallback or simulation
 * @param {string} options.contentSid - Twilio Content Template SID for real interactive messages
 * @param {Object} options.contentVariables - Variables for the Content Template
 * @param {string} options.mediaUrl - URL of media to attach
 * @returns {Promise} - Twilio message promise
 */
async function sendWhatsApp(to, body, options = {}) {
  if (!client) {
    console.log("[DEV] Twilio not configured. Message to", to, ":", body);
    if (options.buttons) {
      console.log("[DEV] Buttons:", JSON.stringify(options.buttons));
    }
    return;
  }

  // 1. Try sending via Content API (Real Interactive Buttons) if SID provided
  if (options.contentSid) {
    try {
      if (options.sendLogoFirst && options.mediaUrl) {
        await client.messages.create({
          from: TWILIO_WHATSAPP_NUMBER,
          to,
          mediaUrl: [options.mediaUrl]
        });
        const delayMs = typeof options.logoDelayMs === "number" ? Math.max(0, Math.min(options.logoDelayMs, 5000)) : 800;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      return await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        contentSid: options.contentSid,
        contentVariables: JSON.stringify(options.contentVariables || {})
      });
    } catch (err) {
      console.error("Failed to send Content API message, falling back to text:", err);
      // Fallback to text below
    }
  }

  // 2. Fallback: Text-based simulation of buttons
  let messageBody = body;
  
  if (options.buttons && Array.isArray(options.buttons) && options.buttons.length > 0) {
    messageBody += "\n\n";
    
    options.buttons.forEach((button, index) => {
      // Use numbers as they are easiest to type
      const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][index] || `${index+1}.`;
      messageBody += `${emoji} ${button.text}\n`;
    });
    
    messageBody += "\nReply with the number or option name.";
  }

  // 3. Send standard message
  const msgData = {
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body: messageBody
  };

  if (options.mediaUrl) {
    if (options.mediaUrl.startsWith("http://") || options.mediaUrl.startsWith("https://")) {
      msgData.mediaUrl = [options.mediaUrl];
    } else {
      console.warn("Skipping invalid mediaUrl (missing protocol):", options.mediaUrl);
    }
  }

  return client.messages.create(msgData);
}

module.exports = sendWhatsApp;
