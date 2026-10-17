const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function toolEnvironment(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const extras = platform === "win32"
    ? [path.win32.join(home, ".local", "bin"), ...["", "msys2/usr/bin", "python3", "python"].map(part => path.win32.join(env.MOZILLABUILD || "C:\\mozilla-build", part))]
    : [path.posix.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const key = Object.keys(env).find(name => name.toLowerCase() === "path") || "PATH";
  return { ...env, [key]: [env.UV_TOOL_BIN_DIR || "", ...extras, env[key] || ""].filter(Boolean).join(platform === "win32" ? ";" : ":") };
}

function gitIdentity(directory, execute = spawnSync, env = toolEnvironment()) {
  const read = key => {
    const result = execute("git", [...(directory ? ["-C", directory] : []), "config", "--get", key], { encoding: "utf8", env, timeout: 5000 });
    return result.status === 0 ? (result.stdout || "").trim() : "";
  };
  return { name: read("user.name"), email: read("user.email") };
}

function validateIdentity(value) {
  if (!value || typeof value.name !== "string" || typeof value.email !== "string" ||
      !value.name.trim() || !/^[^\s@]+@[^\s@]+$/.test(value.email.trim()) || /[\r\n\0]/.test(value.name + value.email)) {
    throw new Error("Enter your Git name and email address. These identify your patches.");
  }
  return { name: value.name.trim(), email: value.email.trim() };
}

module.exports = { toolEnvironment, gitIdentity, validateIdentity };
