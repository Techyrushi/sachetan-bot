require("dotenv").config();
const { upsertDocuments, queryRag, deleteDocument, generateAnswer } = require("../utils/rag");

const TEST_DOC_ID = "test_verify_crud_123";
const TEST_CONTENT = "The secret verification code for the system check is ALPHA-BETA-GAMMA-99. We also sell specialized invisible boxes.";
const TEST_METADATA = { title: "Verification Test", source: "script" };

async function runTest() {
  console.log("🚀 Starting CRUD & Prompt Verification Test...\n");

  try {
    // 1. CREATE / UPSERT
    console.log(`1️⃣  Upserting test document (ID: ${TEST_DOC_ID})...`);
    await upsertDocuments([{ id: TEST_DOC_ID, text: TEST_CONTENT, metadata: TEST_METADATA }]);
    console.log("   ✅ Upsert command sent. Waiting 5 seconds for consistency...");
    await new Promise(r => setTimeout(r, 5000));

    // 2. READ / QUERY (RAG Check)
    console.log("\n2️⃣  Querying for the secret code...");
    const query1 = await queryRag("What is the secret verification code?");
    const match1 = query1.matches.find(m => m.id === TEST_DOC_ID);
    
    if (match1) {
        console.log(`   ✅ Found test document in search results (Score: ${match1.score})`);
        // Generate Answer
        const context1 = query1.matches.map(m => m.metadata.text).join("\n");
        const answer1 = await generateAnswer("What is the secret verification code?", context1);
        console.log(`   🤖 AI Answer: ${answer1}`);
        if (answer1.includes("ALPHA-BETA-GAMMA-99")) {
            console.log("   ✅ AI correctly retrieved the secret code.");
        } else {
            console.warn("   ⚠️ AI Answer did not contain the secret code. (Might be model variability)");
        }

    } else {
        console.error("   ❌ Test document NOT found in search results!");
    }

    // 3. PROMPT ENGINEERING CHECK (Ice Cream)
    console.log("\n3️⃣  Testing 'Out of Scope' Logic (Ice Cream scenario)...");
    const iceCreamPrompt = "I want to buy chocolate ice cream";
    // We pass empty context or generic context to see how it handles it without specific docs
    const iceCreamAnswer = await generateAnswer(iceCreamPrompt, "We sell boxes, bags, and packaging materials.");
    console.log(`   User: "${iceCreamPrompt}"`);
    console.log(`   AI: "${iceCreamAnswer}"`);
    
    if (iceCreamAnswer.toLowerCase().includes("packaging") || iceCreamAnswer.toLowerCase().includes("box")) {
        console.log("   ✅ AI successfully pivoted to packaging.");
    } else {
        console.warn("   ⚠️ AI might have failed to pivot. Check the output.");
    }

    // 4. DELETE
    console.log(`\n4️⃣  Deleting test document (ID: ${TEST_DOC_ID})...`);
    const delResult = await deleteDocument(TEST_DOC_ID);
    console.log(`   Deletion Result: ${delResult}`);
    console.log("   Waiting 5 seconds for consistency...");
    await new Promise(r => setTimeout(r, 5000));

    // 5. VERIFY DELETION
    console.log("\n5️⃣  Verifying deletion...");
    const query2 = await queryRag("What is the secret verification code?");
    const match2 = query2.matches.find(m => m.id === TEST_DOC_ID);
    
    if (!match2) {
        console.log("   ✅ SUCCESS: Test document is GONE from search results.");
    } else {
        console.error(`   ❌ FAILURE: Test document STILL EXISTS (Score: ${match2.score})`);
    }

  } catch (err) {
    console.error("❌ Error during test:", err);
  }
}

runTest();
