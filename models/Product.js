const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true, default: 0 },
    imageUrl: { type: String },
    url: { type: String },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    isActive: { type: Boolean, default: true },
    stock: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", ProductSchema);

