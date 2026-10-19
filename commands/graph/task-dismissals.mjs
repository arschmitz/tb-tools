import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const kinds = new Set(["review", "update", "implement", "submit", "rebase"]);

export function createTaskDismissalStore({ directory } = {}) {
  const root = directory ?? (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis
    ? "" : path.join(os.homedir(), ".tb-tools", "task-dismissals"));
  const memory = new Set();
  const key = (kind, id) => `${kind}:${id}`;
  const filename = value => path.join(root, `${createHash("sha256").update(value).digest("hex")}.json`);

  return {
    has(kind, id) {
      const value = key(kind, id);
      return root ? existsSync(filename(value)) : memory.has(value);
    },
    list() {
      if (!root) return [...memory];
      let files;
      try { files = readdirSync(root); }
      catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      return files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))
        .map(file => JSON.parse(readFileSync(path.join(root, file), "utf8")).key);
    },
    dismiss(kind, id) {
      if (!kinds.has(kind) || typeof id !== "string" || !id.trim() || id.length > 200) {
        throw Object.assign(new Error("A valid task kind and ID are required."), { statusCode: 400 });
      }
      const value = key(kind, id);
      if (!root) {
        memory.add(value);
        return;
      }

      // Keep a separate marker so later task saves cannot undo a dismissal.
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = filename(value);
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ key: value }), { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
