
const assert = require('assert');

// Copy of the function from admin-ai.html
function styleForSender(sender) {
    if (!sender) sender = "";
    const s = sender.trim().toLowerCase();
    
    const isManualAdmin = s === 'admin';
    const isBot = ['bot', 'admin_bulk'].includes(s);
    const right = isManualAdmin || isBot;
    
    let bubbleClass = 'bg-white text-slate-800 border border-slate-200 rounded-bl-none';
    let timeClass = 'text-slate-400';
    let tagLabel = 'User';
    let tagClass = 'bg-slate-100 text-slate-700';
    
    if (isManualAdmin) {
        bubbleClass = 'bg-green-600 text-white rounded-br-none';
        timeClass = 'text-green-100 opacity-75';
        tagLabel = 'Admin';
        tagClass = 'bg-green-100 text-green-700';
    } else if (isBot) {
        bubbleClass = 'bg-blue-600 text-white rounded-br-none';
        timeClass = 'text-blue-100 opacity-75';
        tagLabel = 'AI';
        tagClass = 'bg-blue-100 text-blue-700';
    }
    return { right, bubbleClass, timeClass, tagLabel, tagClass };
}

console.log("Running styleForSender tests...");

// Test 1: Manual Admin (Exact)
let res = styleForSender('admin');
assert.strictEqual(res.tagLabel, 'Admin', 'admin should be Admin');
assert.strictEqual(res.right, true, 'admin should be right aligned');
assert.ok(res.bubbleClass.includes('bg-green-600'), 'admin should be green');

// Test 2: Manual Admin (Mixed Case + Spaces)
res = styleForSender('  Admin  ');
assert.strictEqual(res.tagLabel, 'Admin', 'Admin (trimmed) should be Admin');
assert.strictEqual(res.right, true, 'Admin (trimmed) should be right aligned');
assert.ok(res.bubbleClass.includes('bg-green-600'), 'Admin (trimmed) should be green');

// Test 3: Bot
res = styleForSender('bot');
assert.strictEqual(res.tagLabel, 'AI', 'bot should be AI');
assert.strictEqual(res.right, true, 'bot should be right aligned');
assert.ok(res.bubbleClass.includes('bg-blue-600'), 'bot should be blue');

// Test 4: Admin Bulk
res = styleForSender('admin_bulk');
assert.strictEqual(res.tagLabel, 'AI', 'admin_bulk should be AI');
assert.strictEqual(res.right, true, 'admin_bulk should be right aligned');
assert.ok(res.bubbleClass.includes('bg-blue-600'), 'admin_bulk should be blue');

// Test 5: User
res = styleForSender('user');
assert.strictEqual(res.tagLabel, 'User', 'user should be User');
assert.strictEqual(res.right, false, 'user should be left aligned');
assert.ok(res.bubbleClass.includes('bg-white'), 'user should be white');

// Test 6: Unknown/Null
res = styleForSender(null);
assert.strictEqual(res.tagLabel, 'User', 'null should be User');
res = styleForSender('some_random_person');
assert.strictEqual(res.tagLabel, 'User', 'random should be User');

console.log("✅ All styleForSender tests passed!");
