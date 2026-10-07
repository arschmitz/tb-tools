import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const queues = ["directlyAssignedWaitingOnReview", "groupWaitingForFirstReview"];
const writes = new Map();

export function createReviewHandledStore({ filePath, username = "" } = {}) {
  const file = filePath ?? (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis
    ? "" : path.join(os.homedir(), ".tb-tools", "handled-reviews.json"));
  const user = String(username).trim().toLowerCase() || "local";
  let memory = { users: {} };
  const key = file || Symbol("handled reviews");
  async function read() {
    if (!file) return memory;
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { users: {} };
      throw error;
    }
  }
  async function list() {
    await writes.get(key);
    return Object.values((await read()).users?.[user] || {});
  }
  return {
    list,
    async set(revision, handled, patch = {}) {
      if (!/^D[1-9]\d*$/.test(revision) || typeof handled !== "boolean") {
        throw Object.assign(new Error("A valid revision and handled state are required."), { statusCode: 400 });
      }
      const operation = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        const store = await read();
        store.users ||= {};
        const entries = store.users[user] ||= {};
        if (handled) entries[revision] = {
          id: revision, title: String(patch.title || entries[revision]?.title || revision),
          url: `https://phabricator.services.mozilla.com/${revision}`,
          handled: true, handledAt: Date.now(),
        };
        else delete entries[revision];
        if (file) {
          await mkdir(path.dirname(file), { recursive: true });
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(store), "utf8");
          await rename(temporary, file);
        } else memory = store;
      });
      writes.set(key, operation);
      try { await operation; } finally { if (writes.get(key) === operation) writes.delete(key); }
      return list();
    },
  };
}

export function applyHandledReviews(dashboard, handledReviews) {
  const handled = new Set(handledReviews.map(patch => patch.id));
  const patches = new Map(queues.flatMap(key => dashboard[key] || []).map(patch => [patch.id, patch]));
  return {
    ...dashboard,
    ...Object.fromEntries(queues.filter(key => Array.isArray(dashboard[key])).map(key => [key, dashboard[key].filter(patch => !handled.has(patch.id))])),
    handledReviews: handledReviews.map(patch => ({ ...patch, ...patches.get(patch.id), handled: true })),
  };
}
