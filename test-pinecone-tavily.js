require('dotenv').config();
const { queryRag } = require('./utils/rag');

async function test() {
  console.log("Testing Pinecone query with Impossible Filter...");
  
  const query = "cake box"; // A valid query
  const filter = { type: "ImpossibleType" + Date.now() }; // Impossible filter
  
  // Call queryRag with strict=false (default)
  const result = await queryRag(query, 4, undefined, filter, false);
  
  console.log("Result Answer:", result.answer);
  console.log("Result Context:", result.context);
  
  if (result.context && result.context.includes("[Web Search]")) {
    console.error("FAIL: Tavily fallback was triggered!");
  } else if (result.context === "") {
    console.log("PASS: Context is empty.");
  }

  if (result.answer === "I'm not sure about that. I couldn't find information regarding your query.") {
      console.log("PASS: Correct fallback message received.");
  } else {
      console.error("FAIL: Incorrect fallback message:", result.answer);
  }

  console.log("\nTesting Pinecone query with Valid Query (cake box)...");
  const result2 = await queryRag("cake box", 4, undefined, {}, false);
  if (result2.matches && result2.matches.length > 0) {
      console.log("PASS: Found matches for valid query.");
      console.log("Snippet:", result2.answer.substring(0, 50) + "...");
  } else {
      console.warn("WARN: No matches for 'cake box' (index might be empty or threshold too high).");
  }
}

test().catch(console.error);
