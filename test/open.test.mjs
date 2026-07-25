import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenCommand, getRequestedTargets, getUrlsForTargets } from "../commands/open.mjs";

const context = {
  bugUrl: "https://bugzilla.mozilla.org/show_bug.cgi?id=1234567",
  phabUrl: "https://phabricator.services.mozilla.com/D123456",
  tryUrl: "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
};

test("getRequestedTargets supports positional and flag targets", () => {
  assert.deepEqual(getRequestedTargets({ target: "bug" }), ["bug"]);
  assert.deepEqual(getRequestedTargets({ target: ["bug", "try"] }), ["bug", "try"]);
  assert.deepEqual(getRequestedTargets({ bug: true, phab: true }), ["bug", "phab"]);
  assert.deepEqual(getRequestedTargets({}), ["all"]);
});

test("getUrlsForTargets returns URLs for selected targets", () => {
  assert.deepEqual(getUrlsForTargets(context, ["bug"]), [context.bugUrl]);
  assert.deepEqual(getUrlsForTargets(context, ["all"]), [
    context.bugUrl,
    context.phabUrl,
    context.tryUrl,
  ]);
});

test("open command opens detected URLs", async () => {
  const opened = [];
  const writes = [];
  const openCommand = createOpenCommand({
    getContext: async () => context,
    open: async (url) => opened.push(url),
    write: (message) => writes.push(message),
  });

  await openCommand({ target: ["bug", "try"] });

  assert.deepEqual(opened, [context.bugUrl, context.tryUrl]);
  assert.equal(writes.length, 2);
});

test("open command fails when a requested URL is unavailable", async () => {
  const openCommand = createOpenCommand({
    getContext: async () => ({}),
    open: async () => {
      assert.fail("nothing should open without detected URLs");
    },
  });

  await assert.rejects(openCommand({ target: "bug" }), /No bug link found/);
});
