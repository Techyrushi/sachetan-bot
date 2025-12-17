const twilio = require("twilio");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Send a WhatsApp message with text-based clickable buttons
 * @param {string} to - Recipient phone number
 * @param {string} body - Message body
 * @param {Object} options - Additional options
 * @param {Array} options.buttons - Array of button objects with text and id properties
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

  let messageBody = body;
  
  // If buttons are provided, format them as clickable text options
  if (options.buttons && Array.isArray(options.buttons) && options.buttons.length > 0) {
    messageBody += "\n\n";
    
    options.buttons.forEach((button, index) => {
      // Format as emoji number + button text
      const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][index] || `${index+1}.`;
      messageBody += `${emoji} *[${button.text}]*\n`;
    });
    
    messageBody += "\nTap or reply with the option text.";
  }

  // Send the message with formatted buttons
  const msgData = {
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body: messageBody
  };

  if (options.mediaUrl) {
    msgData.mediaUrl = [options.mediaUrl];
  }

  return client.messages.create(msgData);
}

module.exports = sendWhatsApp;
