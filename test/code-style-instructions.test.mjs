import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { CODE_READABILITY_GUIDANCE, CODE_STYLE_GUIDANCE } from "../commands/knowledge/code-style.mjs";
import { knowledgeInstructions } from "../commands/knowledge/instructions.mjs";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";

test("code style guidance reaches turns with and without a shared checkout", () => {
  for (const repository of ["", "/shared/knowledge"]) {
    const input = knowledgeInstructions("/private/knowledge", repository);
    assert.ok(
      input.includes(CODE_READABILITY_GUIDANCE),
      "All writing and review tasks should receive the full readability guidance."
    );
    assert.ok(
      input.includes(CODE_STYLE_GUIDANCE),
      "Console instructions should include the full scoped code style guidance."
    );
    assert.ok(
      input.includes("Every assertion must have a non-empty message that states the expected behavior."),
      "All console tasks should require assertion messages without a shared checkout."
    );
    assert.ok(
      input.includes("Report missing or empty messages in assertions within the review scope, including"),
      "Reviews should report missing messages in other authors' assertions."
    );
  }
});

test("new and steered console turns receive code style when retrieval is disabled", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.kill = () => child.emit("exit", 0);
  child.stdin = {
    writable: true,
    write(value) {
      const request = JSON.parse(value);
      requests.push(request);
      const turn = { id: "style-turn", status: "completed" };
      queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({
        id: request.id,
        result: request.method === "turn/start" ? { turn }
          : request.method === "thread/start" ? { thread: { id: "thread-1" } }
            : request.method === "threadSection/list"
              ? { data: [{ id: "console-section", name: "TB Console" }], nextCursor: null }
              : {},
      })}\n`));
      if (request.method === "turn/start") {
        setImmediate(() => child.stdout.emit("data", `${JSON.stringify({
          method: "turn/completed", params: { turn },
        })}\n`));
      }
      return true;
    },
  };
  const client = createGraphCodexAppServer({
    command: "codex", cwd: "/review/comm", knowledge: false,
    spawnProcess: () => child,
  });
  try {
    await client.start();
    const code = "const value = readInput();\n\napplyValue(value);";
    const startPrompt = `Implement this behavior:\n${code}`;
    const steerPrompt = `Verify the changed code:\n${code}`;
    await client.startTurn({ threadId: "thread-1", prompt: startPrompt });
    await client.steerTurn({ threadId: "thread-1", turnId: "style-turn", prompt: steerPrompt });
    for (const method of ["turn/start", "turn/steer"]) {
      const request = requests.find(item => item.method === method);
      assert.ok(
        request?.params.input[0].text.includes(CODE_READABILITY_GUIDANCE),
        `${method} should receive readability guidance even when retrieval is disabled.`
      );
      assert.ok(
        request?.params.input[0].text.includes(CODE_STYLE_GUIDANCE),
        `${method} should receive complete code style guidance without retrieval.`
      );
      assert.ok(
        request.params.input[0].text.includes("Every assertion must have a non-empty message that states the expected behavior."),
        `${method} should require assertion messages even when retrieval is disabled.`
      );
      assert.ok(
        request.params.input[0].text.startsWith(method === "turn/start" ? startPrompt : steerPrompt),
        `${method} should preserve the request's code line breaks and blank-line group.`
      );
    }
  } finally {
    client.close();
  }
});

test("guidance distinguishes loop receivers and preserves local exceptions", () => {
  for (const text of [
    "exact language, folder, file role, and section",
    "Array.prototype.forEach does not wait",
    "cal.iterate.forEach yields to the event queue",
    "Check resolved rules when overrides overlap",
    "there is no blanket === mandate",
    "Do not rewrite intentional invalid fixtures",
  ]) {
    assert.ok(
      CODE_STYLE_GUIDANCE.includes(text),
      `Code style guidance should retain the constraint: ${text}.`
    );
  }
});
