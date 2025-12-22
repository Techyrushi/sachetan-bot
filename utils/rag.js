const https = require("https");
const url = require("url");
const OpenAI = require("openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const axios = require("axios");

const DEFAULT_COLLECTION = "website_docs";
const PINECONE_INDEX = process.env.PINECONE_INDEX || "sachetan-index";

let openai = null;
if (process.env.OPENROUTER_API_KEY) {
  openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": process.env.SITE_URL || "https://sachetanpackaging.in",
      "X-Title": process.env.SITE_NAME || "SachetanAI",
    },
  });
}

// Pinecone Client
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY || "pinecone-api-key-placeholder",
});

function httpRequest(method, endpoint, data, headers = {}) {
  // ... (keep helper if needed for OpenRouter, but not for Pinecone as we use SDK)
  return new Promise((resolve, reject) => {
    const target = url.parse(endpoint);
    const isHttps = target.protocol === "https:";
    const client = isHttps ? https : require("http");
    const payload = data ? JSON.stringify(data) : null;
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload ? Buffer.byteLength(payload) : 0,
        ...headers,
      },
    };
    const req = client.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = body ? JSON.parse(body) : {};
          resolve(json);
        } catch (e) {
          resolve(body);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function embedText(text) {
  try {
    if (openai) {
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      return response.data[0].embedding;
    }
    throw new Error("No OpenAI client");
  } catch (error) {
    console.warn("Embedding fallback used (quality may be low)");
    // Fallback: create a 1536-dim vector (approx) to match OpenAI
    // Realistically this fallback is useless for semantic search against OpenAI vectors
    // but prevents crashing.
    const arr = new Array(1536).fill(0); 
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      const idx = i % 1536;
      arr[idx] += s.charCodeAt(i);
    }
    const norm = Math.sqrt(arr.reduce((a, b) => a + b * b, 0)) || 1;
    return arr.map((v) => v / norm);
  }
}

let INDEX_DIMENSION_CACHE = null;
async function getIndexDimension() {
  if (INDEX_DIMENSION_CACHE) return INDEX_DIMENSION_CACHE;
  try {
    const desc = await pc.describeIndex(PINECONE_INDEX);
    const dim =
      desc?.dimension ||
      desc?.index?.dimension ||
      desc?.spec?.dimension ||
      1536;
    INDEX_DIMENSION_CACHE = dim;
    return dim;
  } catch {
    return 1536;
  }
}

function adjustToDimension(values, dim) {
  if (!Array.isArray(values)) return [];
  if (values.length === dim) return values;
  if (values.length > dim) return values.slice(0, dim);
  const out = values.slice();
  while (out.length < dim) out.push(0);
  return out;
}

async function ensureCollection(name = DEFAULT_COLLECTION) {
  // In Pinecone, we use namespaces within an index. 
  // We just verify the index exists.
  try {
    const { indexes } = await pc.listIndexes();
    const exists = indexes.some(i => i.name === PINECONE_INDEX);
    if (!exists) {
        console.log(`Creating Pinecone index: ${PINECONE_INDEX}`);
        await pc.createIndex({
            name: PINECONE_INDEX,
            dimension: 1536, // OpenAI default
            metric: 'cosine',
            spec: { 
                serverless: { 
                    cloud: 'aws', 
                    region: 'us-east-1' 
                }
            } 
        });
        // Wait a bit for initialization
        await new Promise(r => setTimeout(r, 10000));
    }
    return name; // Return namespace name
  } catch (err) {
    console.error("Error ensuring Pinecone index:", err.message);
    throw err;
  }
}

async function upsertDocuments(docs, collectionName = DEFAULT_COLLECTION) {
  // collectionName is treated as namespace
  await ensureCollection(collectionName);
  const index = pc.index(PINECONE_INDEX);
  const namespace = index.namespace(collectionName);
  const dim = await getIndexDimension();
  
  const vectors = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const id = d.id || `doc_${Date.now()}_${i}`;
    const text = d.text || d.content || "";
    const metadata = { ...d.metadata, text }; // Store text in metadata for retrieval
    const valuesRaw = await embedText(text);
    const values = adjustToDimension(valuesRaw, dim);
    
    vectors.push({
      id,
      values,
      metadata
    });
  }

  // Upsert in batches of 100
  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    await namespace.upsert(batch);
  }
  
  return { ok: true, count: vectors.length };
}

async function searchTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return "";
  
  try {
    const response = await axios.post("https://api.tavily.com/search", {
      api_key: apiKey,
      query: `Sachetan Packaging ${query}`,
      search_depth: "basic",
      include_domains: ["sachetanpackaging.in"],
      max_results: 3
    });
    
    if (response.data && Array.isArray(response.data.results)) {
         return response.data.results.map(r => `[Web Search] ${r.title}: ${r.content}`).join("\n\n");
    }
    return "";
  } catch (e) {
    console.error("Tavily search error:", e.message);
    return "";
  }
}

async function queryRag(query, topK = 4, collectionName = DEFAULT_COLLECTION) {
  const dim = await getIndexDimension();
  const queryRaw = await embedText(query);
  const queryEmb = adjustToDimension(queryRaw, dim);
  const index = pc.index(PINECONE_INDEX);
  const namespace = index.namespace(collectionName);
  
  const response = await namespace.query({
    vector: queryEmb,
    topK,
    includeMetadata: true,
  });

  const matches = response.matches || [];
  const docs = matches.map(m => m.metadata?.text || "").filter(Boolean);
  
  // Add Tavily Search
  const webContext = await searchTavily(query);
  if (webContext) {
      docs.push(webContext);
  }

  const context = docs.join("\n\n");
  const answer = await generateAnswer(query, context);
  
  return { answer, context, matches };
}

async function generateAnswer(prompt, context) {
  try {
    if (openai) {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-r1-0528:free",
        messages: [
          { role: "system", content: "You are a representative of Sachetan Packaging. Your goal is to assist customers using ONLY the provided context.\n\nIMPORTANT RULES:\n1. Answer ONLY questions related to Sachetan Packaging business, products, or services.\n2. If the user asks about a topic NOT related to Sachetan Packaging, reply exactly with: 'I don't have information about that.'\n3. Do not mention 'context' or 'database'.\n4. If the provided context does not contain the answer, reply with: 'I don't have information about that.'\n5. Our website is https://sachetanpackaging.in." },
          { role: "user", content: `Context:\n${context}\n\nUser question:\n${prompt}` },
        ],
      });
      return completion.choices[0].message.content;
    }
    const snippet = String(context || "").split("\n").slice(0, 3).join("\n");
    return snippet || "Assistant unavailable.";
  } catch (error) {
    console.error("Generation error:", error.message);
    return "Sorry, I am unable to answer that right now.";
  }
}

module.exports = {
  upsertDocuments,
  queryRag,
  ensureCollection,
  DEFAULT_COLLECTION,
  pingChroma: async () => {
     try {
       const { indexes } = await pc.listIndexes();
       return indexes && indexes.length >= 0;
     } catch {
       return false;
     }
  },
  testOpenRouter: async () => {
    try {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return false;
      const models = await httpRequest(
        "GET",
        "https://openrouter.ai/api/v1/models",
        null,
        {
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": process.env.SITE_URL || "https://sachetanpackaging.in",
          "X-Title": process.env.SITE_NAME || "SachetanAI",
        }
      );
      if (models && Array.isArray(models.data) && models.data.length > 0) return true;
    } catch {}
    try {
      if (!openai) return false;
      const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-r1-0528:free";
      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: "ping" }],
      });
      const content = completion?.choices?.[0]?.message?.content;
      return typeof content === "string" && content.length > 0;
    } catch {
      return false;
    }
  },
  getChromaUrl: () => "https://api.pinecone.io",
};
