const express = require("express");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const router = express.Router();

router.post("/register-first-admin", async (req, res) => {
  // Use only once to create initial admin (or use seeding)
  const { username, password } = req.body;
  try {
    const exists = await Admin.findOne({ username });
    if (exists) return res.status(400).json({ message: "Admin exists" });
    const admin = new Admin({ username, password });
    await admin.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  if (!admin) return res.status(401).json({ message: "Invalid credentials" });
  const valid = await admin.comparePassword(password);
  if (!valid) return res.status(401).json({ message: "Invalid credentials" });
  const token = jwt.sign({ id: admin._id, username: admin.username }, process.env.JWT_SECRET || "secret", { expiresIn: "1d" });
  res.json({ token });
});

module.exports = router;
