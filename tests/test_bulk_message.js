const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

async function run() {
  const base = "http://localhost:4000";
  try {
    // Login admin
    const { data: login } = await axios.post(`${base}/api/auth/login`, {
      username: "admin",
      password: "admin123",
    });
    const token = login.token;
    if (!token) throw new Error("No token");

    // Prepare form-data
    const form = new FormData();
    form.append("file", fs.createReadStream("tests/bulk_contacts.csv"));
    form.append("message", "Hi {{name}}, this is a follow-up from Sachetan Packaging.");

    const res = await axios.post(`${base}/api/admin/ai/bulk-message`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log("Bulk Response:", res.data);
  } catch (err) {
    if (err.response) {
      console.error("Error:", err.response.status, err.response.data);
    } else {
      console.error("Error:", err.message);
    }
  }
}

run();
