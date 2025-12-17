Backend README

1. Copy .env.example to .env and fill values.
2. Run:
   npm install
   npm run dev

3. Create first admin (one-time):
   POST /api/auth/register-first-admin
   body: { "username": "admin", "password": "changeme" }

4. Configure Twilio webhook (Messaging -> WhatsApp sandbox) to:
   POST <BASE_URL>/webhook/twilio

5. Configure Razorpay webhook to POST /api/payments/webhook (optional). In production verify signatures.
