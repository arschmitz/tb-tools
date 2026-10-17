const APP_NAME = "Thunderbird Development Dashboard";
const EXECUTABLE_NAME = APP_NAME;
const APP_ID = "org.thunderbird.development-dashboard";

function packagedExecutable(directory, platform = process.platform) {
  const path = require("node:path");
  return platform === "darwin"
    ? path.join(directory, `${APP_NAME}.app`, "Contents", "MacOS", EXECUTABLE_NAME)
    : path.join(directory, platform === "win32" ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME);
}

module.exports = { APP_NAME, EXECUTABLE_NAME, APP_ID, packagedExecutable };
