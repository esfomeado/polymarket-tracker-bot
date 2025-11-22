const fs = require("fs");
const { LOG_FILE } = require("../config");

try {
  if (fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "");
  }
} catch (error) {
  console.error("Failed to clear log file:", error.message);
}

function logToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data,
  };
  const logLine = `[${timestamp}] [${level}] ${message}${
    data ? ` | Data: ${JSON.stringify(data)}` : ""
  }\n`;

  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (error) {
    console.error("Failed to write to log file:", error.message);
  }

  if (level === "ERROR") {
    console.error(`[${level}] ${message}`, data || "");
  } else if (level === "WARN") {
    console.warn(`[${level}] ${message}`, data || "");
  } else {
    console.log(`[${level}] ${message}`, data || "");
  }
}

module.exports = { logToFile };
