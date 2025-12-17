require("dotenv").config();
const pool = require("./config/mysql");

async function createTable() {
  try {
    const connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`tbl_scraped_pages\` (
        \`id\` int(11) NOT NULL AUTO_INCREMENT,
        \`url\` varchar(255) NOT NULL,
        \`title\` varchar(255) DEFAULT NULL,
        \`content\` longtext,
        \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`url\` (\`url\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("Table tbl_scraped_pages created or already exists.");
    connection.release();
    process.exit(0);
  } catch (err) {
    console.error("Error creating table:", err);
    process.exit(1);
  }
}

createTable();
