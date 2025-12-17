const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, default: 1 },
    total: { type: Number, required: true },
    // Snapshot of product details
    oldPrice: { type: Number },
    size: { type: String },
    color: { type: String },
    dimensions: { type: String }, // LxWxH
    weight: { type: String }
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true }, // Friendly ID e.g. ORD-123456
    whatsapp: { type: String },
    items: { type: [OrderItemSchema], default: [] },
    totalAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "DELIVERED", "CANCELLED", "EXPIRED"],
      default: "PENDING"
    },
    expiresAt: { type: Date },
    razorpayOrderId: { type: String },
    razorpayPaymentLink: { type: String },
    paymentId: { type: String },
    invoiceNumber: { type: String },
    
    // Customer Details
    customerName: { type: String },
    address: { type: String },
    pincode: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", OrderSchema);
