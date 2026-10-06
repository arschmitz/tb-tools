import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberTrySignatures } from "../commands/graph/try-knowledge.mjs";

test("CI memory retains exact matching evidence without claiming a run passed", async () => {
  const records = [];
  const state = { path: "/checkout", sourceHash: "source", attempts: [{ hash: "tested", url: "https://example.test/try" }] };
  const match = { repo: "try-comm-central", revision: "other", id: "42", url: "https://example.test/job" };
  const count = await rememberTrySignatures(state, [
    { signature: "error: exact message", jobs: ["1"], matchCount: 1, match },
    { signature: "unmatched", jobs: ["2"], matchCount: 0 },
  ], { captureSource: async record => records.push(record) });
  assert.equal(count, 1);
  assert.equal(records[0].revision, "tested");
  assert.equal(records[0].type, "ci-signature");
  const data = JSON.parse(records[0].text);
  assert.equal(data.signature, "error: exact message");
  assert.deepEqual(data.matchingPush, match);
  assert.match(data.applicability, /every other failure/);
});

test("CI memories include main branch and other authors without a target match", async () => {
  const { rememberCiPushes } = await import("../commands/graph/try-knowledge.mjs");
  const records = [];
  const pushes = ["comm-central", "try-comm-central"].map(repo => ({repo,revision:repo + "-rev",author:"another author",observations:[{signature:"unmatched exact failure",job:"42",url:"https://example.test/job"}]}));
  assert.equal(await rememberCiPushes({path:"/checkout"},pushes,{captureSource:async r=>records.push(r)},{repository:"thunderbird",revision:"current"}),2);
  assert.deepEqual(records.map(r=>JSON.parse(r.text).repository),["comm-central","try-comm-central"]);
  assert.ok(records.every(r=>r.type==="ci-push-summary"));
});
