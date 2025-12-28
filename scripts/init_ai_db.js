require("dotenv").config();
const pool = require("../config/mysql");

async function run() {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS \`tbl_ai_knowledge\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`doc_id\` VARCHAR(255) NOT NULL UNIQUE,
        \`title\` VARCHAR(255) NOT NULL,
        \`content\` TEXT NOT NULL,
        \`source_type\` ENUM('manual', 'file') DEFAULT 'manual',
        \`source_name\` VARCHAR(255) DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    
    console.log("Creating table tbl_ai_knowledge...");
    await pool.query(query);
    console.log("Table created successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Error creating table:", err);
    process.exit(1);
  }
}

run();
