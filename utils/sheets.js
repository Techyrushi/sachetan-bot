const { google } = require("googleapis");

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !keyRaw) return null;
  const key = keyRaw.replace(/\\n/g, "\n");
  const jwt = new google.auth.JWT(
    email,
    null,
    key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return jwt;
}

function getSheetsApi() {
  const auth = getAuth();
  if (!auth) return null;
  return google.sheets({ version: "v4", auth });
}

async function getSheetIdByTitle(spreadsheetId, title) {
  const sheets = getSheetsApi();
  if (!sheets) return null;
  const doc = await sheets.spreadsheets.get({ spreadsheetId });
  const found = (doc.data.sheets || []).find(s => s.properties && s.properties.title === title);
  return found ? found.properties.sheetId : null;
}

async function ensureSheet(spreadsheetId, title) {
  const sheets = getSheetsApi();
  if (!sheets) return null;
  let sheetId = await getSheetIdByTitle(spreadsheetId, title);
  if (sheetId !== null) return sheetId;
  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: 20 } } } }
      ]
    }
  });
  const replies = resp.data.replies || [];
  const added = replies.find(r => r.addSheet && r.addSheet.properties && r.addSheet.properties.sheetId);
  return added ? added.addSheet.properties.sheetId : null;
}

async function styleHeader(spreadsheetId, sheetId, headerCount) {
  const sheets = getSheetsApi();
  if (!sheets) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                textFormat: { bold: true, foregroundColor: { red: 0, green: 0, blue: 0 } },
                horizontalAlignment: "CENTER"
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
          }
        }
      ]
    }
  });
  return true;
}

async function setHeaderValues(spreadsheetId, title, headers) {
  const sheets = getSheetsApi();
  if (!sheets) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] }
  });
  return true;
}

async function ensureHeaders(range, headers) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const sheets = getSheetsApi();
  if (!spreadsheetId || !sheets) return false;
  const title = String(range).split("!")[0];
  const sheetId = await ensureSheet(spreadsheetId, title);
  await setHeaderValues(spreadsheetId, title, headers);
  await styleHeader(spreadsheetId, sheetId, headers.length);
  return true;
}

async function appendRow(range, values) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const auth = getAuth();
  if (!spreadsheetId || !auth) return false;
  const sheets = google.sheets({ version: "v4", auth });
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
  } catch (e) {
    if (/Unable to parse range/i.test(e.message)) {
      const fbRange = "Sheet1!A1";
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: fbRange,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
    } else {
      throw e;
    }
  }
  return true;
}

async function logConversation(data) {
  const range = process.env.GOOGLE_SHEETS_CONVERSATIONS_RANGE || "Conversations!A1";
  await ensureHeaders(range, ["Timestamp", "Phone", "Name", "City", "Stage", "Message", "Reply", "Media URL"]);
  const values = [
    new Date().toISOString(),
    data.phone || "",
    data.name || "",
    data.city || "",
    data.stage || "",
    data.message || "",
    data.reply || "",
    data.mediaUrl || ""
  ];
  return appendRow(range, values);
}

async function updateRow(range, values) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const auth = getAuth();
  if (!spreadsheetId || !auth) return false;
  const sheets = google.sheets({ version: "v4", auth });
  
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
  return true;
}

async function logLead(data) {
  const rangeName = process.env.GOOGLE_SHEETS_LEADS_RANGE || "Leads!A1";
  const headers = ["Timestamp", "Phone", "Name", "City", "Product", "Size", "Paper", "Quantity", "Printing", "Notes", "Converted"];
  await ensureHeaders(rangeName, headers);

  // Read existing rows to find if user exists
  const rows = await module.exports.readRange(rangeName);
  let rowIndex = -1;
  let existingRow = null;

  if (rows && rows.length > 0) {
    // Assuming Phone is at index 1 (0-based) based on headers above
    // Header row is index 0
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] === data.phone) {
        rowIndex = i + 1; // 1-based index for Sheets
        existingRow = rows[i];
        break;
      }
    }
  }

  const timestamp = new Date().toISOString();
  
  // Prepare new values (merge with existing if needed, but here we overwrite mostly to keep latest state)
  // If updating, keep original timestamp if you want, or update it. Let's update it to show latest activity.
  const values = [
    timestamp,
    data.phone || "",
    data.name || (existingRow ? existingRow[2] : ""),
    data.city || (existingRow ? existingRow[3] : ""),
    data.product || (existingRow ? existingRow[4] : ""),
    data.size || (existingRow ? existingRow[5] : ""),
    data.paper || (existingRow ? existingRow[6] : ""),
    data.quantity || (existingRow ? existingRow[7] : ""),
    data.printing || (existingRow ? existingRow[8] : ""),
    data.notes || (existingRow ? existingRow[9] : ""),
    data.converted === true ? "YES" : (existingRow ? existingRow[10] : "NO"),
  ];

  if (rowIndex !== -1) {
    // Update existing row
    const sheetName = rangeName.split("!")[0];
    const updateRange = `${sheetName}!A${rowIndex}`;
    return updateRow(updateRange, values);
  } else {
    // Append new row
    return appendRow(rangeName, values);
  }
}

async function logUserMedia(phone, mediaUrl) {
  const range = process.env.GOOGLE_SHEETS_MEDIA_RANGE || "User Media!A1";
  await ensureHeaders(range, ["Timestamp", "Phone", "Media URL"]);
  const values = [
    new Date().toISOString(),
    phone || "",
    mediaUrl || ""
  ];
  return appendRow(range, values);
}

async function logQuotation(data) {
  const range = process.env.GOOGLE_SHEETS_QUOTATIONS_RANGE || "Quotations!A1";
  await ensureHeaders(range, ["Timestamp", "Phone", "Customer Name", "Total Amount", "PDF URL"]);
  const values = [
    new Date().toISOString(),
    data.phone || "",
    data.customerName || "",
    data.totalAmount || "",
    data.pdfUrl || ""
  ];
  return appendRow(range, values);
}

module.exports = {
  logConversation,
  logLead,
  logUserMedia,
  logQuotation,
  readRange: async (range) => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheets = getSheetsApi();
    if (!spreadsheetId || !sheets) return [];
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return resp.data.values || [];
  },
  listLeads: async () => {
    let range = process.env.GOOGLE_SHEETS_LEADS_RANGE || "Leads!A1";
    let rows = await module.exports.readRange(range);
    if (!rows || rows.length === 0) {
      try {
        const titles = await module.exports.listSheets();
        const fallbackTitle = (titles || []).find(t => /lead/i.test(String(t)));
        if (fallbackTitle) {
          range = `${fallbackTitle}!A1`;
          rows = await module.exports.readRange(range);
        }
      } catch {}
    }
    if (!rows || rows.length === 0) return [];
    const headers = rows[0];
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        const k = headers[j];
        obj[k] = r[j] || "";
      }
      out.push(obj);
    }
    return out;
  },
  listSheets: async () => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheets = getSheetsApi();
    if (!spreadsheetId || !sheets) return [];
    const doc = await sheets.spreadsheets.get({ spreadsheetId });
    return (doc.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
  }
};
