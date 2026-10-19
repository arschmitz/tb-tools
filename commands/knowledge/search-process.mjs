import { fork } from "node:child_process";

// The desktop backend and CLI run in standalone Node. Keep corpus scans off their event loop.
export function createKnowledgeSearch(directory, {
  workerUrl = new URL("./search-worker.mjs", import.meta.url), timeoutMs = 60_000,
} = {}) {
  let worker, sequence = 0, stopped = false;
  const pending = new Map();
  function fail(child, error) {
    if (worker === child) worker = null;
    for (const [id, request] of pending) {
      if (request.child !== child) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  }
  function start() {
    const child = fork(workerUrl, [directory], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let diagnostic = "";
    child.stderr.on("data", text => { diagnostic = (diagnostic + text).slice(-4000); });
    child.on("message", message => {
      const request = pending.get(message.id);
      if (!request || request.child !== child) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    child.on("error", error => fail(child, error));
    child.on("exit", (code, signal) => fail(child,
      new Error(`Knowledge search process exited (${signal || code}). ${diagnostic}`)));
    child.unref();
    child.channel?.unref();
    worker = child;
    return child;
  }
  return {
    search(query, operation = "search") {
      if (stopped) return Promise.reject(new Error("Knowledge search is closed."));
      const child = worker || start(), id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(child, new Error(`Knowledge search timed out after ${timeoutMs}ms.`));
          child.kill("SIGKILL");
        }, timeoutMs);
        pending.set(id, { child, resolve, reject, timer });
        try {
          child.send({ id, query, operation }, error => {
            if (error) { fail(child, error); child.kill(); }
          });
        } catch (error) { fail(child, error); child.kill(); }
      });
    },
    missingSections(model) { return this.search({ model }, "missingSections"); },
    async close() {
      stopped = true;
      const child = worker;
      if (!child) return;
      fail(child, new Error("Knowledge search is closed."));
      if (child.exitCode !== null || child.signalCode) return;
      await new Promise(resolve => {
        child.once("close", resolve);
        child.kill("SIGKILL");
      });
    },
  };
}
