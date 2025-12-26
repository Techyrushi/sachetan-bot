require("dotenv").config();
const { upsertDocuments } = require("../utils/rag");

const documents = [
  // 1. PAPER VARIETIES
  {
    id: "paper_variety_itc",
    text: "ITC Grade Paper (Food Grade) is a premium quality paper suitable for direct food contact. It is safe for packaging food items directly.",
    metadata: { source: "manual_entry", category: "paper_variety", type: "ITC Grade", quality: "Premium", food_grade: "Yes" }
  },
  {
    id: "paper_variety_economy",
    text: "Economy Grade Paper (Grey Back Paper) is a cost-effective option. It is typically used for non-direct food packaging or budget-friendly packaging solutions.",
    metadata: { source: "manual_entry", category: "paper_variety", type: "Economy Grade", quality: "Standard", food_grade: "No (Non-direct)" }
  },
  
  // 2. AVAILABLE GSM
  {
    id: "available_gsm",
    text: "We offer paper in the following GSM (Grams per Square Meter) options: 350 GSM and 400 GSM.",
    metadata: { source: "manual_entry", category: "gsm", values: "350, 400" }
  },

  // 3. BOX SIZES & PRICING
  {
    id: "box_pricing_7x7x5",
    text: "Box Size: 7 x 7 x 5 inches. Price Range: ₹6.00 – ₹11.00 per piece. Note: Prices depend on paper type and quantity.",
    metadata: { source: "manual_entry", category: "pricing", size: "7x7x5", price_min: 6.00, price_max: 11.00 }
  },
  {
    id: "box_pricing_8x8x5",
    text: "Box Size: 8 x 8 x 5 inches. Price Range: ₹8.00 – ₹12.50 per piece. Note: Prices depend on paper type and quantity.",
    metadata: { source: "manual_entry", category: "pricing", size: "8x8x5", price_min: 8.00, price_max: 12.50 }
  },
  {
    id: "box_pricing_10x10x5",
    text: "Box Size: 10 x 10 x 5 inches. Price Range: ₹10.00 – ₹18.00 per piece. Note: Prices depend on paper type and quantity.",
    metadata: { source: "manual_entry", category: "pricing", size: "10x10x5", price_min: 10.00, price_max: 18.00 }
  },
  // General pricing note
  {
    id: "pricing_general_note",
    text: "The listed prices for boxes are per piece. Final price varies based on quantity and paper selection.",
    metadata: { source: "manual_entry", category: "pricing_policy" }
  },

  // 4. TAX DETAILS
  {
    id: "tax_details",
    text: "GST is charged at 5% extra on top of the quoted box price.",
    metadata: { source: "manual_entry", category: "tax", rate: "5%" }
  },

  // 5. TRANSPORT & LOGISTICS
  {
    id: "transport_policy",
    text: "Transport charges are extra and are NOT included in the box price. We provide delivery coverage across India only.",
    metadata: { source: "manual_entry", category: "logistics_policy" }
  },
  {
    id: "logistics_general",
    text: "Our available transport services include Nashik Goods Transport, VRL Transport, and Option Transport Co. We deliver across India.",
    metadata: { source: "manual_entry", category: "logistics_summary" }
  },
  {
    id: "logistics_nashik_goods",
    text: "Nashik Goods Transport is one of our available transport service partners.",
    metadata: { source: "manual_entry", category: "logistics_provider", name: "Nashik Goods Transport" }
  },
  {
    id: "logistics_vrl",
    text: "VRL Transport is one of our available transport service partners.",
    metadata: { source: "manual_entry", category: "logistics_provider", name: "VRL Transport" }
  },
  {
    id: "logistics_option",
    text: "Option Transport Co is one of our available transport service partners.",
    metadata: { source: "manual_entry", category: "logistics_provider", name: "Option Transport Co" }
  }
];

async function run() {
  console.log(`Starting upsert of ${documents.length} documents...`);
  try {
    // Using default collection (usually "website_docs")
    const result = await upsertDocuments(documents);
    console.log("Upsert successful!");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Upsert failed:", err);
  }
}

run();
