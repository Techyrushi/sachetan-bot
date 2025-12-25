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
  await ensureHeaders(range, ["Timestamp", "Phone", "Name", "City", "Stage", "Message", "Reply"]);
  const values = [
    new Date().toISOString(),
    data.phone || "",
    data.name || "",
    data.city || "",
    data.stage || "",
    data.message || "",
    data.reply || "",
  ];
  return appendRow(range, values);
}

async function logLead(data) {
  const range = process.env.GOOGLE_SHEETS_LEADS_RANGE || "Leads!A1";
  await ensureHeaders(range, ["Timestamp", "Phone", "Name", "City", "Product", "Size", "Paper", "Quantity", "Printing", "Notes", "Converted"]);
  const values = [
    new Date().toISOString(),
    data.phone || "",
    data.name || "",
    data.city || "",
    data.product || "",
    data.size || "",
    data.paper || "",
    data.quantity || "",
    data.printing || "",
    data.notes || "",
    data.converted === true ? "YES" : "NO",
  ];
  return appendRow(range, values);
}

module.exports = {
  logConversation,
  logLead,
  listSheets: async () => {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheets = getSheetsApi();
    if (!spreadsheetId || !sheets) return [];
    const doc = await sheets.spreadsheets.get({ spreadsheetId });
    return (doc.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
  }
};
