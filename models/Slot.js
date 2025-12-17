const mongoose = require("mongoose");
const SlotSchema = new mongoose.Schema({
  time: String, // e.g. "06:00 - 07:00"
  price: Number,
  status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
});
module.exports = mongoose.model("Slot", SlotSchema);
