const mongoose = require("mongoose");
const BookingSchema = new mongoose.Schema({
  bookingId: { type: String }, // Custom ID: NP-01, NP-02, etc.
  invoiceNumber: { type: String }, // NP-2025-01, etc.
  whatsapp: String,
  date: String, // YYYY-MM-DD
  slot: String,
  slotId: { type: mongoose.Schema.Types.ObjectId, ref: "Slot" },
  courtName: String,
  courtId: { type: mongoose.Schema.Types.ObjectId, ref: "Court" },
  duration: String,
  amount: Number,
  playerCount: Number,
  razorpayOrderId: String,
  paymentId: String,
  status: {
    type: String,
    enum: ["pending_payment", "confirmed", "cancelled", "expired"],
    default: "pending_payment"
  },
  reminded24h: { type: Boolean, default: false },
  reminded1h: { type: Boolean, default: false },
  confirmedAt: Date,
  checkedIn: { type: Boolean, default: false },
  checkedInTime: Date,
  sequence_value: { type: Number, default: 0 },
  modifiedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" }, // For modification tracking
  modifiedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" }, // For modification tracking
}, { timestamps: true });

module.exports = mongoose.model("Booking", BookingSchema);