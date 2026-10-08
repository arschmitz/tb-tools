import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ensureTbToolsIdInCommitMessage, getTbToolsIdFromCommitMessage, installTbToolsCommitMsgHook } from "../lib/commit-message.mjs";
import { getLegacyToolsId, migrateRepositoryPatchIdentities, resolvePatchIdentity, savePatchIdentityAlias } from "../lib/patch-identity.mjs";
import { finishSubmittedPatchIdentity } from "../lib/submitted-patch-identity.mjs";
import { createTryMonitorStore, isLatestTryWorkflow } from "../commands/graph/try-monitor-store.mjs";
import { findCurrentTrySource } from "../commands/graph/try-source.mjs";
import { assertTryRepairOwner, getTryRepairOwnerRef, getTryRepairScope } from "../commands/graph/try-repair-coordination.mjs";
import { getGraphTryRunsForCommit, recordGraphTryRun } from "../commands/graph/data.mjs";
import { createGraphSubmitSession } from "../commands/graph/actions.mjs";
import { createTryMonitor } from "../commands/graph/try-monitor.mjs";

const execute = promisify(execFile);
const revision = "https://phabricator.services.mozilla.com/D123456";
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-patch-identity-"));
  const previous = process.env.TB_TOOLS_PATCH_IDENTITY_DIRECTORY;
  process.env.TB_TOOLS_PATCH_IDENTITY_DIRECTORY = path.join(root, "aliases");
  t.after(async () => {
    if (previous === undefined) delete process.env.TB_TOOLS_PATCH_IDENTITY_DIRECTORY;
    else process.env.TB_TOOLS_PATCH_IDENTITY_DIRECTORY = previous;
    await rm(root, { recursive: true, force: true });
  });
  const git = async (...args) => (await execute("git", args, { cwd: root })).stdout.trim();
  const runCommand = async command => (await execute(command.cmd, command.args, { cwd: command.cwd || root })).stdout;
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "source"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("switch", "-c", "Bug-123456");
  const commit = async (id, differential = "") => {
    await writeFile(path.join(root, "source"), `${id}\n`);
    await git("add", "source");
    const message = `Bug 123456 - Change\n\nTB-Tools-Id: ${id}${differential ? `\nDifferential Revision: ${differential}` : ""}`;
    await git("commit", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { root, git, runCommand, commit };
}

test("submitted messages use the revision and do not regain a tools trailer through the hook", async t => {
  const { root, git, runCommand, commit } = await setup(t);
  await installTbToolsCommitMsgHook({ cwd: root, runCommand });
  const hookPath = path.join(root, ".git/hooks/commit-msg");
  const oldHook = (await readFile(hookPath, "utf8")).replace(/^if \(hasCommitText.*$/m, "if (hasCommitText && !pattern.test(message)) {");
  await writeFile(hookPath, `${oldHook}\n# custom hook rule\n`);
  assert.equal(await installTbToolsCommitMsgHook({ cwd: root, runCommand }), true);
  assert.match(await readFile(hookPath, "utf8"), /# custom hook rule/);
  const message = `Bug 123456 - Change\n\nDifferential Revision: ${revision}`;
  assert.equal(ensureTbToolsIdInCommitMessage(message).id, revision);
  assert.equal(ensureTbToolsIdInCommitMessage(message).message, message);
  await commit("legacy", revision);
  await git("commit", "--amend", "-m", message);
  assert.equal(getLegacyToolsId(await git("show", "-s", "--format=%B")), "");
  assert.equal(getTbToolsIdFromCommitMessage(await git("show", "-s", "--format=%B")), revision);
  await git("switch", "-c", "unsubmitted", "main");
  await writeFile(path.join(root, "source"), "new\n");
  await git("add", "source");
  await git("commit", "-m", "Bug 2 - New patch");
  assert.ok(getLegacyToolsId(await git("show", "-s", "--format=%B")));
});

test("migration finds reflog-only commits, leaves missing or conflicting IDs, and is repeatable", async t => {
  const { root, git, runCommand, commit } = await setup(t);
  await commit("legacy", revision);
  await git("reset", "--hard", "main");
  await commit("conflict", revision);
  await commit("conflict", "https://phabricator.services.mozilla.com/D654321");
  await commit("unsubmitted");
  await migrateRepositoryPatchIdentities({ cwd: root, runCommand });
  assert.equal(resolvePatchIdentity("legacy"), revision);
  assert.equal(resolvePatchIdentity("conflict"), "conflict");
  assert.equal(resolvePatchIdentity("unsubmitted"), "unsubmitted");
  assert.equal(resolvePatchIdentity("missing"), "missing");
  const ambiguousRuns = await getGraphTryRunsForCommit({ graph: { path: root, label: "comm" },
    commit: { hash: await git("rev-parse", "HEAD"), subject: "Bug 123456 - Change" },
    store: { runs: [{ url: "https://treeherder.mozilla.org/jobs?repo=try&revision=old", tbToolsId: "conflict", subject: "Bug 123456 - Change" }] },
    runCommand: async command => command.args[0] === "log" ? `Bug 123456 - Change\n\nDifferential Revision: ${revision}` : "patch-id" });
  assert.equal(ambiguousRuns.length, 0);
  await migrateRepositoryPatchIdentities({ cwd: root, runCommand });
  assert.equal(resolvePatchIdentity("legacy"), revision);
  assert.throws(() => savePatchIdentityAlias("legacy", "https://phabricator.services.mozilla.com/D999999"), /more than one/);
  await commit("external-submit", revision);
  await migrateRepositoryPatchIdentities({ cwd: root, runCommand, ids: ["external-submit"] });
  assert.equal(resolvePatchIdentity("external-submit"), revision);
});

test("first submit replaces the local trailer and retains the tree and staged edits across restart", async t => {
  const { root, git, runCommand, commit } = await setup(t);
  const original = await commit("legacy");
  const beforeMessage = await git("show", "-s", "--format=%B");
  const tree = await git("rev-parse", "HEAD^{tree}");
  const parents = await git("show", "-s", "--format=%P");
  const store = createTryMonitorStore(path.join(root, "monitor"));
  const graph = { path: root, label: "comm" };
  const url = "https://treeherder.mozilla.org/jobs?repo=try&revision=abc";
  await recordGraphTryRun({ graph, runCommand, tryRun: { url, hash: original, tbToolsId: "legacy", subject: "Bug 123456 - Change" } });
  store.save({ id: "active", path: root, sourceRef: "refs/heads/Bug-123456", sourceHash: original,
    tbToolsId: "legacy", fixupTargetTbToolsId: "legacy", phase: "waiting", attempts: [{ id: "one", url, hash: original }] });
  const message = `${beforeMessage}\nTb-Implement-Step: old-step\nDifferential Revision: ${revision}`;
  await git("commit", "--amend", "-m", message);
  await writeFile(path.join(root, "staged"), "unrelated\n");
  await git("add", "staged");
  await finishSubmittedPatchIdentity({ beforeMessage, message, runCommand });
  const submitted = await git("rev-parse", "HEAD");
  assert.equal(await git("rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git("show", "-s", "--format=%P"), parents);
  assert.equal(getLegacyToolsId(await git("show", "-s", "--format=%B")), "");
  assert.doesNotMatch(await git("show", "-s", "--format=%B"), /Tb-Implement-Step:/);
  assert.equal(await git("diff", "--cached", "--name-only"), "staged");
  const restarted = createTryMonitorStore(store.directory).read("active");
  assert.equal(restarted.tbToolsId, revision);
  assert.equal(restarted.fixupTargetTbToolsId, revision);
  assert.equal(restarted.attempts[0].hash, original);
  assert.equal(await findCurrentTrySource(restarted, runCommand), submitted);
  const runs = await getGraphTryRunsForCommit({ graph: { path: root, label: "comm" }, commit: { hash: submitted }, runCommand });
  assert.ok(runs.some(run => run.url === url && run.tbToolsId === revision));
  store.save(restarted);
  assert.equal(JSON.parse(await readFile(path.join(store.directory, "active.json"), "utf8")).tbToolsId, revision);
  assert.equal(isLatestTryWorkflow(restarted, [restarted, { id: "new", path: root, tbToolsId: "legacy", attempts: [{ createdAt: "2099-01-01" }] }]), false);
});

test("old repair ownership and locks still apply after the ID changes", async t => {
  const { root, git, runCommand, commit } = await setup(t);
  const sourceHash = await commit("legacy");
  const state = { path: root, sourceHash, tbToolsId: "legacy" };
  const oldScope = await getTryRepairScope(state, runCommand);
  const oldRef = getTryRepairOwnerRef("legacy");
  await git("commit", "--allow-empty", "-m", "fixup! Change");
  const fixup = await git("rev-parse", "HEAD");
  await git("update-ref", oldRef, fixup);
  savePatchIdentityAlias("legacy", revision);
  const migratedMessage = ensureTbToolsIdInCommitMessage("Bug 1 - Old patch\n\nTB-Tools-Id: legacy").message;
  assert.equal(getLegacyToolsId(migratedMessage), "");
  assert.equal(getTbToolsIdFromCommitMessage(migratedMessage), revision);
  const newScope = await getTryRepairScope({ ...state, tbToolsId: revision }, runCommand);
  assert.ok(oldScope.every(key => newScope.includes(key)));
  await assert.rejects(assertTryRepairOwner({ state, targetId: revision, expectedHash: sourceHash, runCommand }), error => error.code === "TRY_REPAIR_OWNED" && error.ownerHash === fixup);
});

test("monitor migrates old IDs before deciding which active Try owns a patch", async t => {
  const { root, runCommand, commit } = await setup(t);
  const sourceHash = await commit("legacy", revision);
  const store = createTryMonitorStore(path.join(root, "monitor"));
  const attempt = time => ({ id: time, createdAt: time, url: `https://treeherder.mozilla.org/jobs?repo=try&revision=${"a".repeat(40)}` });
  store.save({ id: "old", path: root, sourceHash, tbToolsId: "legacy", phase: "analyzing", nextCheckAt: 0,
    attempts: [attempt("2026-01-01")] });
  store.save({ id: "new", path: root, sourceHash: "new-hash", tbToolsId: revision, phase: "waiting", nextCheckAt: 0,
    attempts: [attempt("2026-01-02")] });
  const monitor = createTryMonitor({ graphs: [{ path: root }], store, runCommand, now: () => Date.parse("2026-01-03"),
    aiEnabled: false, treeherder: { inspect: async () => ({ jobs: [{}], complete: false, failures: [] }) },
    repairer: { assess: async () => assert.fail("Old analysis must not start") } });
  await monitor.tick();
  assert.equal(store.read("old").tbToolsId, revision);
  assert.equal(store.read("old").phase, "superseded");
  assert.equal(JSON.parse(await readFile(path.join(store.directory, "old.json"), "utf8")).tbToolsId, revision);
  assert.equal(store.read("new").phase, "waiting");
});

test("Submit replays descendant branches onto the commit after trailer removal", async t => {
  const { root, git, runCommand, commit } = await setup(t);
  await commit("legacy");
  await git("branch", "Bug-alias");
  await git("switch", "-c", "Bug-child");
  await writeFile(path.join(root, "child"), "child\n");
  await git("add", "child");
  await git("commit", "-m", "Bug 2 - Child");
  await git("switch", "Bug-123456");
  const session = createGraphSubmitSession({ graph: { path: root, label: "comm", branch: "Bug-123456" }, getSnapshot: async () => ({}),
    runCommand: async command => {
      if (command.cmd === "moz-phab") {
        await git("commit", "--amend", "-m", `${await git("show", "-s", "--format=%B")}\nDifferential Revision: ${revision}`);
        return `Submitted ${revision}\n`;
      }
      return runCommand(command);
    }, postComment: async () => assert.fail("Unexpected remote comment") });
  const deadline = Date.now() + 20000;
  while (!["complete", "error", "canceled"].includes(session.status) && Date.now() < deadline) {
    if (session.prompt) session.answer(session.prompt.id, false);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(session.status, "complete", session.error || session.output);
  const parent = await git("rev-parse", "Bug-123456");
  assert.equal(await git("rev-parse", "Bug-alias"), parent);
  assert.equal(await git("rev-parse", "Bug-child^"), parent);
  assert.equal(getLegacyToolsId(await git("show", "-s", "--format=%B", parent)), "");
  assert.equal(await git("show", "Bug-child:child"), "child");
});
