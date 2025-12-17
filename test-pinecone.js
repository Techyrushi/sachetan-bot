require("dotenv").config();
const { upsertDocuments, queryRag, pingChroma, getChromaUrl } = require("./utils/rag");
const { scrapeUrl, chunkText } = require("./utils/scraper");

async function test() {
  try {
    const hasApiKey = !!process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX || "(default)";
    console.log("Env check -> PINECONE_API_KEY:", hasApiKey ? "set" : "missing", "| PINECONE_INDEX:", indexName);
    console.log("Checking Vector DB connection...");
    const isAlive = await pingChroma();
    console.log("Vector DB Alive:", isAlive);
    console.log("Vector DB URL:", getChromaUrl());

    if (!hasApiKey) {
      console.error("Missing PINECONE_API_KEY in .env. Please set it and re-run.");
      return;
    }

    if (!isAlive) {
      console.error("Vector DB is not reachable. Check your PINECONE_API_KEY.");
      // We might continue if it's just a listing error but let's see.
    }

    // 1. Upsert a simple doc
    console.log("Upserting dummy doc...");
    const upRes = await upsertDocuments([{
      id: "test_doc_pinecone_1",
      text: "The secret code for the website verification is PINEAPPLE_JUICE.",
      metadata: { source: "test" }
    }], "test_collection_pinecone");
    console.log("Upsert result:", JSON.stringify(upRes));

    // Wait for consistency (Pinecone is eventually consistent)
    console.log("Waiting 5s for consistency...");
    await new Promise(r => setTimeout(r, 5000));
    
    // 2. Query
    console.log("Querying...");
    const result = await queryRag("What is the secret code?", 4, "test_collection_pinecone");
    console.log("Matches:", result.matches.length);
    console.log("Answer:", result.answer);
    console.log("Context:", result.context);

  } catch (e) {
    console.error("Error:", e);
  }
}

test();
