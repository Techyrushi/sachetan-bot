require("dotenv").config();
const { upsertDocuments } = require("../utils/rag");

const logisticsCompanies = [
  {
    id: "logistics_nashik_goods",
    text: "Nashik Goods Transport is a logistics partner available for shipping and transport.",
    metadata: { source: "system", type: "logistics", name: "Nashik Goods Transport" }
  },
  {
    id: "logistics_vrl",
    text: "VRL Transport Company is a logistics partner available for shipping and transport.",
    metadata: { source: "system", type: "logistics", name: "VRL Transport Company" }
  },
  {
    id: "logistics_arco",
    text: "ARCO TRANSPORT CO. is a logistics partner available for shipping and transport.",
    metadata: { source: "system", type: "logistics", name: "ARCO TRANSPORT CO." }
  },
  {
    id: "logistics_general",
    text: "Our logistics and shipping partners include Nashik Goods Transport, VRL Transport Company, and ARCO TRANSPORT CO. We use these services for delivering goods.",
    metadata: { source: "system", type: "logistics", summary: "true" }
  }
];

async function run() {
  console.log("Upserting logistics data...");
  try {
    const result = await upsertDocuments(logisticsCompanies);
    console.log("Success:", result);
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
