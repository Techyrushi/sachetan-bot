require("dotenv").config();
const { upsertDocuments, queryRag } = require("../utils/rag");

async function test() {
  console.log("Testing RAG...");
  
  const testDocId = "test_verification_" + Date.now();
  const testText = "Sachetan Packaging offers a special discount of 20% on all pizza boxes during the monsoon season.";
  
  console.log("1. Upserting document...");
  try {
    const res = await upsertDocuments([{ id: testDocId, text: testText, metadata: { title: "Test Doc" } }]);
    console.log("Upsert result:", res);
  } catch (e) {
    console.error("Upsert failed:", e);
    return;
  }

  // Wait for consistency
  console.log("Waiting 5s for indexing...");
  await new Promise(r => setTimeout(r, 5000));

  console.log("2. Querying...");
  try {
    const query = "What is the discount on pizza boxes?";
    const res = await queryRag(query);
    console.log("\n--- Query Result ---");
    console.log("Query:", query);
    console.log("Matches:", res.matches.map(m => `${m.score.toFixed(4)} - ${m.metadata.text.substring(0, 50)}...`));
    console.log("Answer:", res.answer);
    
    // Check if our document is in the top matches
    const found = res.matches.some(m => m.id === testDocId);
    if (found) {
        console.log("\n✅ SUCCESS: Test document found in retrieval.");
    } else {
        console.log("\n❌ FAILURE: Test document NOT found in retrieval.");
    }

  } catch (e) {
    console.error("Query failed:", e);
  }
}

test();