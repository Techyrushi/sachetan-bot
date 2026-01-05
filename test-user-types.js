require('dotenv').config();
const { queryRag } = require('./utils/rag');

async function testUserTypes() {
  const types = ["Homebakers", "Store Owner/ Bulk Buyer", "Sweet Shop Owner"];
  const query = "cake box price"; // A generic query relevant to all

  console.log("=== Starting User Type Verification Test ===\n");

  for (const type of types) {
    console.log(`Testing User Type: ${type}`);
    const filter = { type: type };
    
    try {
        const result = await queryRag(query, 3, undefined, filter, true); // strict=true
        
        console.log(`[PASS] Query executed for ${type}`);
        
        if (result.matches && result.matches.length > 0) {
            console.log(`[INFO] Found ${result.matches.length} matches.`);
            // Verify matches have correct metadata if possible (requires looking at matches array if returned)
            // rag.js returns { answer, mediaUrls, context, matches }
            
            const matchTypes = result.matches.map(m => m.metadata ? m.metadata.type : "unknown");
            console.log(`[INFO] Match Types: ${matchTypes.join(", ")}`);
            
            const allMatch = matchTypes.every(t => t === type || t === "all" || !t); // "all" might be a universal type
            if (allMatch) {
                console.log(`[PASS] All matches are valid for ${type}.`);
            } else {
                console.warn(`[WARN] Some matches might not be for ${type}: ${matchTypes}`);
            }
            
            console.log(`[INFO] Answer Snippet: ${result.answer.substring(0, 100)}...`);
        } else {
            console.warn(`[WARN] No matches found for ${type}. This might be expected if no specific data exists yet.`);
            console.log(`[INFO] Answer: ${result.answer}`);
        }

    } catch (error) {
        console.error(`[FAIL] Error querying for ${type}:`, error);
    }
    console.log("-".repeat(40) + "\n");
  }

  // Test Fallback
  console.log("Testing Fallback Response (Impossible Query)...");
  const impossibleQuery = "xyz123impossiblequery";
  const resultFallback = await queryRag(impossibleQuery, 3, undefined, { type: "Homebakers" }, true);
  
  if (resultFallback.answer.includes("couldn't find specific information") || resultFallback.answer.includes("I apologize")) {
      console.log(`[PASS] Fallback message received: \n${resultFallback.answer}`);
  } else {
      console.log(`[FAIL] Unexpected fallback: ${resultFallback.answer}`);
  }

  console.log("\n=== Test Complete ===");
}

testUserTypes().catch(console.error);
