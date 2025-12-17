const axios = require("axios");
const cheerio = require("cheerio");

async function scrapeUrl(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);

    // Remove scripts, styles, and other non-content elements
    $("script").remove();
    $("style").remove();
    $("noscript").remove();
    $("iframe").remove();
    $("nav").remove();
    $("footer").remove();
    $("header").remove();

    // Extract text from main content areas
    // We prioritize main, article, and then fall back to body but with the removals above
    let content = "";
    
    // Try to find specific content containers first
    const contentSelectors = ["main", "article", "#content", ".content", ".main", "#main"];
    let foundSpecific = false;

    for (const selector of contentSelectors) {
      if ($(selector).length > 0) {
        content += $(selector).text();
        foundSpecific = true;
      }
    }

    // If no specific content container found, use body
    if (!foundSpecific) {
      content = $("body").text();
    }

    // Clean up whitespace
    content = content
      .replace(/\s+/g, " ")
      .replace(/\n+/g, "\n")
      .trim();

    const title = $("title").text().trim();

    return {
      url,
      title,
      content,
    };
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
    throw new Error(`Failed to scrape ${url}`);
  }
}

function chunkText(text, maxChunkSize = 1000) {
  const chunks = [];
  let currentChunk = "";
  
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChunkSize) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += " " + sentence;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

module.exports = {
  scrapeUrl,
  chunkText,
};
