import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function aliasDirectory() {
  return process.env.TB_TOOLS_PATCH_IDENTITY_DIRECTORY || path.join(os.homedir(), ".tb-tools", "patch-identities");
}

function aliasFile(id) {
  return path.join(aliasDirectory(), `${createHash("sha256").update(id).digest("hex")}.json`);
}

export function getDifferentialIdentity(message = "") {
  const value = String(message).match(/^Differential Revision:\s*(https?:\/\/[^\s]+\/D\d+)\s*$/im)?.[1];
  if (!value) return "";
  try { return new URL(value).href; }
  catch { return ""; }
}

export function getLegacyToolsId(message = "") {
  return String(message).match(/^TB-Tools-Id:\s*([^\s]+)\s*$/im)?.[1] || "";
}

export function resolvePatchIdentity(id = "") {
  if (!id) return "";
  try {
    const alias = JSON.parse(readFileSync(aliasFile(id), "utf8"));
    if (alias.id !== id || getDifferentialIdentity(`Differential Revision: ${alias.revision}`) !== alias.revision) {
      throw new Error(`Invalid saved alias for patch ID ${id}.`);
    }
    return alias.revision;
  } catch (error) {
    if (error.code === "ENOENT") return id;
    throw error;
  }
}

// Each old ID has one immutable alias. Concurrent submissions cannot overwrite it.
export function savePatchIdentityAlias(id, revision) {
  if (!id || !revision || id === revision) return;
  if (getDifferentialIdentity(`Differential Revision: ${revision}`) !== revision) throw new Error("Invalid Differential Revision identity.");
  const directory = aliasDirectory();
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ id, revision }), { mode: 0o600, flag: "wx" });
  try {
    try { linkSync(temporary, aliasFile(id)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (resolvePatchIdentity(id) !== revision) throw new Error(`Patch ID ${id} refers to more than one Differential Revision.`);
  } finally { unlinkSync(temporary); }
}

export function migratePatchIdentityFields(value) {
  if (!value || typeof value !== "object") return value;
  for (const [key, entry] of Object.entries(value)) {
    if (["tbToolsId", "fixupTargetTbToolsId", "repairTargetTbToolsId", "tryId", "localPatchId"].includes(key) && typeof entry === "string") {
      value[key] = resolvePatchIdentity(entry);
    } else if (key !== "evidence" && entry && typeof entry === "object") migratePatchIdentityFields(entry);
  }
  return value;
}

export function getPatchIdentityAliases(id) {
  const revision = resolvePatchIdentity(id);
  const identities = new Set([id, revision]);
  if (!existsSync(aliasDirectory())) return [...identities];
  for (const file of readdirSync(aliasDirectory()).filter(file => file.endsWith(".json"))) {
    const alias = JSON.parse(readFileSync(path.join(aliasDirectory(), file), "utf8"));
    if (alias.revision === revision) identities.add(alias.id);
  }
  return [...identities];
}

export async function migrateRepositoryPatchIdentities({ cwd, runCommand, ids = [] }) {
  if (!existsSync(cwd)) return;
  if (!existsSync(path.join(cwd, ".git")) && !existsSync(path.join(cwd, "objects"))) return;
  const git = async args => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true })).trim();
  const common = path.resolve(cwd, await git(["rev-parse", "--git-common-dir"]));
  if (!existsSync(path.join(common, "config"))) return;
  const marker = path.join(common, "tb-tools-patch-identities-v1");
  const completed = existsSync(marker);
  const unresolved = ids.filter(id => id && !id.startsWith("http") && resolvePatchIdentity(id) === id);
  if (completed && !unresolved.length) return;
  const messages = (await git(["log", "--all", "--reflog", "--format=%B%x00", "--fixed-strings", "--regexp-ignore-case",
    ...(completed ? unresolved.map(id => `--grep=TB-Tools-Id: ${id}`) : ["--grep=TB-Tools-Id:"])])).split("\0");
  const mappings = new Map();
  for (const message of messages) {
    const id = getLegacyToolsId(message);
    const revision = getDifferentialIdentity(message);
    if (!id || !revision) continue;
    const revisions = mappings.get(id) || new Set();
    revisions.add(revision);
    mappings.set(id, revisions);
  }
  for (const [id, revisions] of mappings) {
    // Leave conflicting history unresolved. Never choose a revision by date.
    if (revisions.size === 1) savePatchIdentityAlias(id, [...revisions][0]);
  }
  writeFileSync(marker, "1\n", { mode: 0o600 });
}
