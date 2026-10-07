import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function createRebaseSessionStore({ directory } = {}) {
  const root = directory ?? ((process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis)
    ? "" : path.join(os.homedir(), ".tb-tools", "rebase-sessions"));
  const previous = new Map();
  return {
    save(session) {
      if (!root || !session.graph) return;
      const { graph } = session;
      const state = Object.fromEntries(Object.entries(session).filter(([key]) => !["graph", "resolutionBusy", "continueBusy"].includes(key)));
      const content = JSON.stringify({ state, graph: { path: graph.path, label: graph.label,
        checkout: graph.checkout, repository: graph.repository, taskWorktree: Boolean(graph.taskWorktree),
        branchNamespace: graph.branchNamespace, repositoryPath: graph.repositoryPath,
        taskId: graph.taskId } }, (_key, value) => value instanceof Map ? { savedMapEntries: [...value] } : value);
      if (previous.get(session.id) === content) return;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = path.join(root, `${session.id}.json`);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, file);
      previous.set(session.id, content);
    },
    load(graphs) {
      if (!root) return [];
      let files;
      try { files = readdirSync(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      return files.filter(file => /^[a-f0-9-]+\.json$/.test(file)).flatMap(file => {
        const saved = JSON.parse(readFileSync(path.join(root, file), "utf8"), (_key, value) =>
          value && Object.keys(value).length === 1 && Array.isArray(value.savedMapEntries) ? new Map(value.savedMapEntries) : value);
        const source = graphs.find(graph => graph.path === (saved.graph.repositoryPath || saved.graph.path));
        if (!source) return [];
        return [{ ...saved.state, graph: { ...source, ...saved.graph, knownHashes: new Set() },
          resolutionBusy: false, continueBusy: false }];
      });
    },
    remove(id) {
      if (!root) return;
      try { unlinkSync(path.join(root, `${id}.json`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      previous.delete(id);
    },
  };
}
