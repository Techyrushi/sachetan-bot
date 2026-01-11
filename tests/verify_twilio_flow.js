
const axios = require('axios');

const BASE_URL = 'http://localhost:4000'; // Adjust port if needed

async function testTwilioFlow() {
  console.log("Starting Twilio Flow Test...");

  // 1. Simulate User Sending "Hi"
  console.log("\n[Test 1] User sends 'Hi'...");
  try {
    const response = await axios.post(`${BASE_URL}/webhook/twilio`, {
      From: 'whatsapp:+1234567890',
      Body: 'Hi',
      MessageSid: 'SM_TEST_MSG_SID_1',
      SmsStatus: 'received'
    });
    console.log("✅ Server responded:", response.status);
    // Note: We can't easily see the *outgoing* messages from here without mocking sendWhatsApp, 
    // but we can check if it didn't crash and ideally checks logs if possible.
    // In a real integration test we would spy on the sendWhatsApp module.
  } catch (error) {
    console.error("❌ Error sending 'Hi':", error.message);
  }

  // 2. Simulate Status Callback (Delivered)
  console.log("\n[Test 2] Status Callback (Delivered)...");
  try {
    const response = await axios.post(`${BASE_URL}/webhook/twilio/status`, {
      MessageSid: 'SM_TEST_BOT_REPLY_SID', // Hypothetical SID of bot's reply
      MessageStatus: 'delivered'
    });
    console.log("✅ Status Callback (delivered) responded:", response.status);
  } catch (error) {
    console.error("❌ Error sending status callback:", error.message);
  }

  // 3. Simulate Status Callback (Read/Blue Tick)
  console.log("\n[Test 3] Status Callback (Read)...");
  try {
    const response = await axios.post(`${BASE_URL}/webhook/twilio/status`, {
      MessageSid: 'SM_TEST_BOT_REPLY_SID',
      MessageStatus: 'read'
    });
    console.log("✅ Status Callback (read) responded:", response.status);
  } catch (error) {
    console.error("❌ Error sending status callback:", error.message);
  }
  
  console.log("\nTests Completed. Check server logs/database for actual verification.");
}

testTwilioFlow();
