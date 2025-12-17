require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const connectDB = require("./config/db");
const startCronJobs = require("./utils/cronJobs");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// connect DB
connectDB();

// routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/payment", require("./routes/payment"));
app.use("/webhook/twilio", require("./routes/twilio"));

// simple pay link for demo
app.get("/pay", async (req, res) => {
  const Booking = require("./models/Booking");
  const bookingId = req.query.booking;
  if (!bookingId) return res.send("Missing booking id");
  const b = await Booking.findById(bookingId);
  if (!b) return res.send("Booking not found");
  b.status = "confirmed";
  b.confirmedAt = new Date();
  await b.save();
  // send whatsapp confirmation
  const sendWhatsApp = require("./utils/sendWhatsApp");
  await sendWhatsApp(b.whatsapp, `🎉 Payment received. Booking ${b._id} confirmed for ${b.date} ${b.slot}.`);
  res.send(`Payment simulated. Booking ${b._id} confirmed. Close this window.`);
});

// serve admin-panel build if present
const adminBuild = path.join(__dirname, "..", "admin-panel", "dist");
app.use(express.static(adminBuild));
app.get("/", (req, res) => {
  res.sendFile(path.join(adminBuild, "index.html"), err => {
    if (err) res.json({ ok: true, message: "API running" });
  });
});

// start cron jobs
startCronJobs();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
