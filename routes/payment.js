const express = require("express");
const Razorpay = require("razorpay");
const Booking = require("../models/Booking");
const Slot = require("../models/Slot");
const bodyParser = require("body-parser");
const sendWhatsApp = require("../utils/sendWhatsApp");
const path = require("path");
const mongoose = require("mongoose");
const Order = require("../models/Order");

const router = express.Router();
router.use(bodyParser.json());

// Initialize Razorpay with fallback for testing
const razor = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_ROwggD6SO2W63d",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "9L6QHo5bRY4GMW3wacJgM9SJ",
});

// Helper function to find booking by either _id or bookingId
async function findBookingById(id) {
  // Check if it's a valid MongoDB ObjectId
  if (mongoose.Types.ObjectId.isValid(id)) {
    const booking = await Booking.findById(id);
    if (booking) return booking;
  }

  // If not found by ObjectId, try finding by bookingId (NP-01, etc.)
  return await Booking.findOne({ bookingId: id });
}

// Serve payment page
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/payment.html"));
});

// Serve scan page
router.get("/scan", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/scan.html"));
});

router.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/privacy.html"));
});

router.get("/terms&conditions", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/terms.html"));
});

router.get("/logo", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/assets/sachetan_logo.png"));
});

router.get("/favicon", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/assets/favicon.png"));
});

// Serve receipt page
router.get("/receipt/:id", async (req, res) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).send("Booking not found");

    res.sendFile(path.join(__dirname, "../public/receipt.html"));
  } catch (e) {
    res.status(500).send("Error retrieving receipt");
  }
});

// E-commerce: serve product payment and receipt pages
router.get("/product", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/order-payment.html"));
});

router.get("/product/receipt/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/order-receipt.html"));
});

// Admin login page
router.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin-ai.html"));
});

// Get booking details for payment page
router.get("/booking/:id", async (req, res) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    res.json({
      id: booking._id,
      bookingId: booking.bookingId, // Include the custom booking ID
      date: booking.date,
      slot: booking.slot,
      court: booking.courtName,
      player: booking.playerCount,
      amount: booking.amount,
      status: booking.status,
      checkedIn: booking.checkedIn || false,
      duration: booking.duration, // Include duration
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get order details for product payment page
router.get("/product/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check expiration
    if (order.status === "PENDING" && order.expiresAt && new Date() > new Date(order.expiresAt)) {
      order.status = "EXPIRED";
      await order.save();
    }

    res.json({
      id: order._id,
      orderId: order.orderId,
      items: order.items,
      totalAmount: order.totalAmount,
      status: order.status,
      razorpayOrderId: order.razorpayOrderId,
      invoiceNumber: order.invoiceNumber,
      createdAt: order.createdAt,
      whatsapp: order.whatsapp,
      customerName: order.customerName,
      address: order.address,
      pincode: order.pincode,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get receipt data
router.get("/receipt-data/:id", async (req, res) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    res.json({
      id: booking._id,
      bookingId: booking.bookingId,
      date: booking.date,
      slot: booking.slot,
      court: booking.courtName,
      player: booking.playerCount,
      amount: booking.amount,
      status: booking.status,
      paymentId: booking.paymentId,
      invoiceNumber: booking.invoiceNumber,
      createdAt: booking.createdAt,
      checkedIn: booking.checkedIn || false,
      duration: booking.duration,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Razorpay order
router.post("/create-order", async (req, res) => {
  const { bookingId, amount } = req.body;
  try {
    const booking = await findBookingById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Use booking amount if available, fallback to provided amount
    const paymentAmount = booking.amount || amount || 0;

    // Ensure we have a valid amount
    if (!paymentAmount || isNaN(paymentAmount)) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    // Create Razorpay order (amount in smallest currency unit)
    const order = await razor.orders.create({
      amount: Math.round(paymentAmount * 100), // e.g., 200 INR -> 20000 paise
      currency: "INR",
      receipt: `booking_${booking.bookingId || booking._id}`,
      notes: {
        bookingId: booking._id.toString(), // Store MongoDB ID in notes
        customBookingId: booking.bookingId, // Store custom ID as well
        date: booking.date,
        slot: booking.slot,
        court: booking.courtName,
        player: booking.playerCount,
        duration: booking.duration,
      },
    });

    // Save order id with booking
    booking.razorpayOrderId = order.id;
    await booking.save();

    res.json({
      order_id: order.id,
      currency: order.currency,
      amount: order.amount,
      key: process.env.RAZORPAY_KEY_ID,
      displayAmount: paymentAmount,
      booking: {
        id: booking._id,
        bookingId: booking.bookingId,
        date: booking.date,
        slot: booking.slot,
        court: booking.courtName,
        player: booking.playerCount,
        duration: booking.duration,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Razorpay order for product
router.post("/product/create-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.totalAmount || isNaN(order.totalAmount)) {
      return res.status(400).json({ error: "Invalid order amount" });
    }
    const rzpOrder = await razor.orders.create({
      amount: Math.round(order.totalAmount * 100),
      currency: "INR",
      receipt: `order_${order._id}`,
      notes: {
        orderId: order._id.toString(),
      },
    });
    order.razorpayOrderId = rzpOrder.id;
    await order.save();
    res.json({
      order_id: rzpOrder.id,
      currency: rzpOrder.currency,
      amount: rzpOrder.amount,
      key: process.env.RAZORPAY_KEY_ID,
      displayAmount: order.totalAmount,
      order: {
        id: order._id,
        items: order.items,
        totalAmount: order.totalAmount,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify product payment
router.post("/verify-product", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      orderId,
    } = req.body;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "9L6QHo5bRY4GMW3wacJgM9SJ");
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest("hex");

    if (generated_signature === razorpay_signature) {
      order.status = "PAID";
      order.paymentId = razorpay_payment_id;
      // Generate Invoice Number if not exists
      if (!order.invoiceNumber) {
        const date = new Date();
        const year = date.getFullYear();
        const count = await Order.countDocuments({ status: "PAID" }); // Simple counter
        order.invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(4, "0")}`;
      }
      await order.save();

      // Send WhatsApp Confirmation
      const itemsList = order.items.map((item, i) => {
        return `${i + 1}. *${item.name}* (x${item.quantity}) - ₹${item.total}`;
      }).join('\n');

      const receiptLink = `${process.env.BASE_URL || "http://localhost:4000"}/payment/product/receipt/${order._id}`;

      await sendWhatsApp(order.whatsapp,
        `✅ *Payment Received & Order Confirmed!*
        
🆔 *Order ID:* ${order.orderId || order._id}
📄 *Invoice:* ${order.invoiceNumber}
📅 *Date:* ${new Date().toLocaleDateString()}

🛒 *Items:*
${itemsList}

💰 *Total Amount:* ₹${order.totalAmount}

📥 *Download Receipt:*
${receiptLink}

Thank you for choosing Sachetan Packaging! We will process your order shortly.`,
        {
          buttons: [
            { id: 'menu', text: 'Main Menu' }
          ],
          contentSid: process.env.TWILIO_CONTENT_SID_ORDER_INVOICE,
          contentVariables: {
            "1": order.orderId || order._id.toString(),
            "2": order.invoiceNumber,
            "3": new Date().toLocaleDateString(),
            "4": itemsList,
            "5": String(order.totalAmount),
            "6": order._id.toString(),
          }
        }
      );

      return res.json({ success: true });
    } else {
      return res.status(400).json({ error: "Signature verification failed" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Payment verification
router.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      bookingId,
    } = req.body;

    const booking = await findBookingById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Check if the court is still available before confirming
    const slot = await Slot.findById(booking.slotId);
    if (!slot) {
      return res.status(404).json({ error: "Slot not found" });
    }

    // Get current date and time
    const currentDate = new Date();
    const bookingDate = new Date(booking.date);

    // Only check for existing bookings if:
    // 1. The booking date is in the future, OR
    // 2. The booking date is today but the slot time hasn't passed yet
    let shouldCheckBookings = true;

    if (bookingDate < currentDate) {
      shouldCheckBookings = false;
    } else if (bookingDate.toDateString() === currentDate.toDateString()) {
      const slotTimeParts = slot.time.split(" - ")[1];
      if (slotTimeParts) {
        const [hours, minutes] = slotTimeParts.split(":").map(Number);
        const slotEndTime = new Date(currentDate);
        slotEndTime.setHours(hours, minutes, 0, 0);

        if (currentDate > slotEndTime) {
          shouldCheckBookings = false;
        }
      }
    }

    if (shouldCheckBookings) {
      // Get all confirmed bookings for the same court, date, and time slot
      const existingBookings = await Booking.find({
        date: booking.date,
        slotId: booking.slotId,
        courtId: booking.courtId,
        status: "confirmed",
        _id: { $ne: booking._id },
      });

      // Calculate total players already booked
      let totalBookedPlayers = 0;
      existingBookings.forEach((existingBooking) => {
        totalBookedPlayers += existingBooking.playerCount || 1;
      });

      // Calculate available player capacity
      const availablePlayers = 4 - totalBookedPlayers;

      // Check if the current booking can be accommodated
      if (availablePlayers < booking.playerCount) {
        return res.status(409).json({
          error: `This court only has capacity for ${availablePlayers} more player(s) for this time slot. Your booking requires ${booking.playerCount} players. Please choose another court, time slot, or reduce the number of players.`,
          courtUnavailable: true,
          availablePlayers: availablePlayers,
          requestedPlayers: booking.playerCount,
        });
      }

      if (existingBookings.length > 0) {
        console.log(
          `Court ${booking.courtName} has ${totalBookedPlayers} players booked, ${availablePlayers} spots available for ${booking.date} ${booking.slot}`
        );
      }
    }

    // Update booking status
    booking.status = "confirmed";
    booking.confirmedAt = new Date();
    booking.paymentId = razorpay_payment_id;
    await booking.save();

    // Generate receipt URL using the custom booking ID
    const receiptUrl = `${process.env.BASE_URL || "http://localhost:4000"
      }/payment/receipt/${booking.bookingId || booking._id}?invoice=${booking.invoiceNumber}`;

    // Send WhatsApp confirmation
    // Send WhatsApp confirmation to user
    if (booking.whatsapp) {
      const qrCodeLink = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${booking.bookingId || booking._id}`;
      const message = `✅ *Booking Confirmed!*

🆔 Booking ID: ${booking.bookingId}
📅 Date: ${booking.date}
⏰ Time: ${booking.slot}
⏱️ Duration: ${booking.duration}
🎾 Court: ${booking.courtName}
👥 Players: ${booking.playerCount}
💵 Total Amount: ₹${booking.amount}
📄 Invoice: ${booking.invoiceNumber}

View your receipt: ${receiptUrl}

QR Code for check-in: ${qrCodeLink}

Thank you for booking with NashikPicklers! Reply 'menu' to return to main menu.`;

      // Send to user
      await sendWhatsApp(booking.whatsapp, message);

      // Send to multiple admins
      const adminWhatsAppList = process.env.ADMIN_WHATSAPP
        ? process.env.ADMIN_WHATSAPP.split(',').map(num => num.trim())
        : [];

      if (adminWhatsAppList.length > 0) {
        const adminMessage = `📢 *New Booking Confirmed!*

📞 User: ${booking.whatsapp}
🆔 Booking ID: ${booking.bookingId}
🎾 Court: ${booking.courtName}
📅 Date: ${booking.date}
⏰ Time: ${booking.slot}
⏱️ Duration: ${booking.duration}
👥 Players: ${booking.playerCount}
💵 Total Amount: ₹${booking.amount}
📄 Invoice: ${booking.invoiceNumber}

This is an automated admin notification.`;

        for (const admin of adminWhatsAppList) {
          try {
            await sendWhatsApp(admin, adminMessage);
          } catch (err) {
            console.error(`Failed to send WhatsApp to admin ${admin}:`, err.message);
          }
        }
      }
    }

    res.json({
      success: true,
      booking: {
        id: booking._id,
        bookingId: booking.bookingId,
        status: booking.status,
        date: booking.date,
        slot: booking.slot,
        court: booking.courtName,
        player: booking.playerCount,
        amount: booking.amount,
        paymentId: razorpay_payment_id,
        receiptUrl: receiptUrl,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Payment verification for product order
router.post("/product/verify", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.status = "PAID";
    order.paymentId = razorpay_payment_id;
    await order.save();
    const receiptUrl = `${process.env.BASE_URL || "http://localhost:4000"}/payment/product/receipt/${order._id}`;
    if (order.whatsapp) {
      const message = `✅ *Order Confirmed!*\n\n🧾 Invoice: ${order.invoiceNumber || "-"}\n💵 Amount: ₹${order.totalAmount}\n📦 Items:\n${order.items.map(i => `• ${i.name} x${i.quantity} - ₹${i.total}`).join("\n")}\n\nView your receipt: ${receiptUrl}\n\nThank you for shopping with Sachetan Packaging! Reply 'menu' to return to main menu.`;
      await sendWhatsApp(order.whatsapp, message);
    }
    res.json({ success: true, order: { id: order._id, status: order.status, receiptUrl } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check-in a player
router.post("/check-in/:id", async (req, res) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (booking.status !== "confirmed") {
      return res
        .status(400)
        .json({ error: "Only confirmed bookings can be checked in" });
    }

    if (booking.checkedIn) {
      return res.status(400).json({ error: "Player already checked in" });
    }

    booking.checkedIn = true;
    booking.checkedInTime = new Date();
    await booking.save();

    // Format check-in time for display
    const checkInTime = new Date(booking.checkedInTime).toLocaleString(
      "en-US",
      {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }
    );

    // Send notification to multiple admins
    const adminWhatsAppList = process.env.ADMIN_WHATSAPP
      ? process.env.ADMIN_WHATSAPP.split(',').map(num => num.trim())
      : [];

    if (adminWhatsAppList.length > 0) {
      const message = `🎾 Player Check-In Alert

A player [${booking.whatsapp}] has just checked in:

📋 Booking Details:
🆔 Booking ID: ${booking.bookingId}
🎾 Court: ${booking.courtName}
📅 Date: ${booking.date}
⏰ Time: ${booking.slot}
⏱️ Duration: ${booking.duration}
👥 Players: ${booking.playerCount}
💰 Amount: ₹${booking.amount}
⏰ Check-in Time: ${checkInTime}

This is an automated notification.`;

      for (const admin of adminWhatsAppList) {
        try {
          await sendWhatsApp(admin, message);
        } catch (err) {
          console.error(`Failed to send WhatsApp to ${admin}:`, err.message);
        }
      }
    }

    res.json({
      success: true,
      message: "Player checked in successfully",
      booking: {
        id: booking._id,
        bookingId: booking.bookingId,
        date: booking.date,
        slot: booking.slot,
        court: booking.courtName,
        player: booking.playerCount,
        amount: booking.amount,
        status: booking.status,
        checkedIn: booking.checkedIn,
        checkedInTime: booking.checkedInTime,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel booking
router.post("/cancel/:id", async (req, res) => {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (booking.status === "confirmed") {
      return res
        .status(400)
        .json({ error: "Cannot cancel a confirmed booking" });
    }

    booking.status = "cancelled";
    await booking.save();

    // Optional WhatsApp notification
    if (booking.whatsapp) {
      await sendWhatsApp(
        booking.whatsapp,
        `❌ Booking Cancelled

🆔 Booking ID: ${booking.bookingId}
📅 Date: ${booking.date}
⏰ Time: ${booking.slot}
🎾 Court: ${booking.courtName}
👥 Players: ${booking.playerCount}

Your booking has been cancelled successfully.`
      );
    }

    res.json({ success: true, bookingId: booking.bookingId, amount: booking.amount, status: booking.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple webhook (for Razorpay webhooks)
router.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;
    const payment = payload.payload?.payment?.entity;
    const bookingId = payment?.notes?.bookingId;

    if (bookingId) {
      const booking = await findBookingById(bookingId);
      if (booking && booking.status !== "confirmed") {
        booking.status = "confirmed";
        booking.confirmedAt = new Date();
        booking.paymentId = payment.id;
        await booking.save();

        // Generate receipt URL
        const receiptUrl = `${process.env.BASE_URL || "http://localhost:4000"
          }/payment/receipt/${booking.bookingId || booking._id}`;

        if (booking.whatsapp) {
          const qrCodeLink = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${booking.bookingId || booking._id}`;
          await sendWhatsApp(
            booking.whatsapp,
            `✅ *Booking Confirmed!*

🆔 Booking ID: ${booking.bookingId}
📅 Date: ${booking.date}
⏰ Time: ${booking.slot}
⏱️ Duration: ${booking.duration}
🎾 Court: ${booking.courtName}
👥 Players: ${booking.playerCount}
💵 Total Amount: ₹${booking.amount}
📄 Invoice: ${booking.invoiceNumber}

View your receipt: ${receiptUrl}

QR Code for check-in: ${qrCodeLink}

Thank you for booking with NashikPicklers! Reply 'menu' to return to main menu.`
          );
        }
      }
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
  res.sendStatus(200);
});

module.exports = router;
