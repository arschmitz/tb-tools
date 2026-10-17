const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const object = value => value && typeof value === "object" && !Array.isArray(value);

function readConfig(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Could not read the existing .tb.json settings. Fix that file before saving keys. Existing settings were kept.");
  }
  if (!object(config) || ["phabricator", "bugzilla"].some(key => key in config && !object(config[key]))) {
    throw new Error("The existing .tb.json settings must contain JSON objects. Fix that file before saving keys. Existing settings were kept.");
  }
  return config;
}

function credentialStatus(file) {
  try {
    const config = readConfig(file);
    return { phabricatorUser: typeof config.phabricator?.user === "string" ? config.phabricator.user : "",
      hasPhabricatorToken: Boolean(config.phabricator?.token), hasBugzillaKey: Boolean(config.bugzilla?.apiKey) };
  } catch (error) { return { error: error.message }; }
}

function saveCredentials(file, values) {
  const config = readConfig(file);
  const text = (key, label) => {
    const value = values?.[key] ?? "";
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new Error(`${label} must be a single line of text.`);
    }
    return value.trim();
  };
  const user = text("phabricatorUser", "The Phabricator username");
  const token = text("phabricatorToken", "The Phabricator API token");
  const apiKey = text("bugzillaKey", "The Bugzilla API key");
  const phabricator = { ...config.phabricator };
  if (user) phabricator.user = user;
  if (token) phabricator.token = token;
  if ((token || (user && user !== config.phabricator?.user)) && !(phabricator.user && phabricator.token)) {
    throw new Error("Enter both your Phabricator username and API token, or leave both blank.");
  }
  if (!phabricator.token && !apiKey && !config.bugzilla?.apiKey) {
    throw new Error("Enter an API token or key before saving.");
  }
  if (user || token) config.phabricator = phabricator;
  if (apiKey) config.bugzilla = { ...config.bugzilla, apiKey };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { credentialStatus, saveCredentials };
