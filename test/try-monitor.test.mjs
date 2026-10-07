import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTryMonitorStore, monitorRuns, TRY_CHECK_INTERVAL_MS, TRY_STATUS_CHECK_INTERVAL_MS } from "../commands/graph/try-monitor-store.mjs";
import { createTryMonitor } from "../commands/graph/try-monitor.mjs";
import { validateTryAssessment, formatTryFixupMessage, getTryRepairActivity } from "../commands/graph/try-repair.mjs";
import { createTreeherderClient, parseTryUrl } from "../commands/graph/treeherder.mjs";
import { addTryAttempt, saveTrySubmissionOutput } from "../commands/graph/try-submission.mjs";
import { getGraphTryRunsForCommit } from "../commands/graph/data.mjs";

async function setup(t, phase = "waiting") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-monitor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTryMonitorStore(directory);
  const state = { id: "test", path: directory, hash: "abc", sourceHash: "abc", subject: "Bug 123 - Feature",
    phase, nextCheckAt: 0, attempts: [{ id: "one", marker: "tb-try-monitor:one", url: "https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40), createdAt: new Date(0).toISOString() }] };
  store.save(state);
  return { store, state, directory };
}
const evidence = { failures: [{ id: "job" }], baseline: [] };
const assessment = cause => ({ failures: [{ id: "job", cause, reason: "Exact error and source evidence", evidence: ["log URL and source lines"] }] });
const failed = { jobs: [{}], complete: true, failures: [{ id: "job" }] };

test("usage limits stop assessment retries across restart until reset", async t => {
  const { store } = await setup(t);
  let time = 100, calls = 0;
  const create = () => createTryMonitor({ store, now: () => time,
    treeherder: { inspect: async () => failed, compare: async () => evidence },
    repairer: { assess: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("usage limit"), { code: "usage_limit_exceeded", retryAt: 999999 });
      return assessment("unrelated");
    } } });
  await create().tick();
  time = 900000;
  await create().tick();
  assert.equal(calls, 1);
  time = 1000000;
  await create().tick();
  assert.equal(calls, 2);
  assert.equal(store.read("test").phase, "passed");
});

for (const cause of ["unrelated", "unknown"]) {
  test(`completed Try with ${cause} failures has the correct pass decision`, async t => {
    const { store } = await setup(t);
    const monitor = createTryMonitor({ store, now: () => 100,
      treeherder: { inspect: async () => failed, compare: async () => evidence },
      repairer: { assess: async () => assessment(cause), repair: async () => assert.equal(cause, "unknown") } });
    await monitor.tick();
    const saved = store.read("test");
    assert.equal(saved.phase, cause === "unrelated" ? "passed" : "repairing");
    assert.equal(saved.nextCheckAt, 100 + TRY_CHECK_INTERVAL_MS);
    assert.deepEqual(saved.evidence, evidence);
    assert.deepEqual(saved.attempts[0].assessment, assessment(cause));
  });
}

test("restart resumes each checkpoint, creates one fixup and amends it on later failures", async t => {
  const { store } = await setup(t);
  let repairs = 0;
  let submits = 0;
  let time = 0;
  const repairer = {
    assess: async () => assessment("patch"),
    async repair(state) {
      repairs++;
      assert.equal(Boolean(state.fixupHash), repairs > 1);
      state.fixupHash = `fixup-${repairs}`;
      state.phase = "ready-to-submit";
      store.save(state);
      if (repairs === 1) throw new Error("simulated process stop after commit");
    },
    async submit(state) {
      submits++;
      addTryAttempt(state, time);
      state.attempts.at(-1).url = "second";
      state.phase = "waiting";
    },
  };
  const make = () => createTryMonitor({ store, now: () => time, repairer,
    treeherder: { inspect: async () => submits > 1 ? { jobs: [{}], failures: [], complete: true } : failed, compare: async () => evidence } });
  await make().tick();
  assert.equal(store.read("test").phase, "ready-to-submit");
  time += TRY_CHECK_INTERVAL_MS;
  await make().tick();
  assert.equal(repairs, 1);
  assert.equal(submits, 1);
  time += TRY_CHECK_INTERVAL_MS;
  await make().tick();
  assert.equal(repairs, 2);
  assert.equal(submits, 2);
  time += TRY_CHECK_INTERVAL_MS;
  await make().tick();
  assert.equal(store.read("test").phase, "passed");
  assert.equal(store.read("test").attempts.length, 3);
});

test("overdue checks resume after restart and future checks retain their due time", async t => {
  const { store } = await setup(t);
  let checks = 0;
  const create = now => createTryMonitor({ store, now: () => now, repairer: {},
    treeherder: { inspect: async () => { checks++; return { jobs: [], failures: [], complete: false }; } } });
  await create(100).tick();
  await create(200).tick();
  assert.equal(checks, 1);
  await create(100 + TRY_CHECK_INTERVAL_MS).tick();
  assert.equal(checks, 2);
  assert.equal(store.read("test").phase, "waiting");
});

test("an interrupted push is reconciled by marker without submitting again", async t => {
  const { store, state } = await setup(t, "submitting");
  state.attempts[0].url = "";
  store.save(state);
  let found = false;
  const treeherder = {
    findSubmission: async marker => { assert.equal(marker, "tb-try-monitor:one"); return found ? "recovered" : ""; },
    inspect: async url => { assert.equal(url, "recovered"); return { jobs: [], failures: [], complete: false }; },
  };
  const create = time => createTryMonitor({ store, treeherder, now: () => time, repairer: { submit: () => assert.fail("duplicate push") } });
  await create(0).tick();
  assert.equal(store.read("test").phase, "submitting");
  found = true;
  // Use a valid receipt for the production URL validator.
  treeherder.findSubmission = async () => "https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40);
  treeherder.inspect = async () => ({ jobs: [], failures: [], complete: false });
  await create(TRY_CHECK_INTERVAL_MS).tick();
  assert.equal(store.read("test").phase, "waiting");
  assert.equal(store.read("test").attempts.length, 1);
});

test("streamed push receipts survive a crash before command completion", async t => {
  const { store, state } = await setup(t, "submitting");
  state.attempts[0].url = "";
  saveTrySubmissionOutput(state, store, "Pushed https://treeherder.mozilla.org/jobs?repo=try&revision=");
  saveTrySubmissionOutput(state, store, "b".repeat(40) + "\n");
  assert.match(createTryMonitorStore(store.directory).read("test").attempts[0].url, /b{40}$/);
});

test("a second worker does not process a locked workflow", async t => {
  const { store } = await setup(t);
  const unlock = store.lock("test");
  assert.equal(store.lock("test"), null);
  await createTryMonitor({ store, repairer: {}, treeherder: { inspect: () => assert.fail("locked") } }).tick();
  unlock();
  const other = store.lock("test");
  assert.ok(other);
  other();
});

test("network failure stays pending and preserves the next retry time", async t => {
  const { store } = await setup(t);
  await createTryMonitor({ store, repairer: {}, now: () => 10,
    treeherder: { inspect: async () => { throw new Error("offline"); } } }).tick();
  assert.equal(store.read("test").phase, "waiting");
  assert.equal(store.read("test").error, "offline");
  assert.equal(store.read("test").nextCheckAt, 10 + TRY_CHECK_INTERVAL_MS);
});

test("malformed or incomplete assessments cannot claim a pass", () => {
  for (const value of [{}, { failures: [] }, { failures: [{ id: "job", cause: "unrelated" }] },
    { failures: [assessment("unrelated").failures[0], assessment("unrelated").failures[0]] }]) {
    assert.throws(() => validateTryAssessment(value, evidence));
  }
  assert.deepEqual(validateTryAssessment(assessment("unknown"), evidence), assessment("unknown"));
});

test("fixup messages require cumulative detailed causes, changes, validation and limits", () => {
  const state = { id: "id", subject: "Bug 123 - Feature", attempts: [{ url: "first" }, { url: "second" }] };
  const report = { causes: "A callback read stale state.", changes: "foo.js now reads the current state before sending.",
    validation: "node --test test/foo.test.mjs: 4 passed.", limits: "Cross-platform tests will run on Try." };
  const message = formatTryFixupMessage(state, report);
  assert.ok(message.startsWith("fixup! Bug 123 - Feature\n"));
  for (const text of [...Object.values(report), "first\nsecond", "Tb-Try-Monitor: id"]) assert.ok(message.includes(text));
  assert.throws(() => formatTryFixupMessage(state, { ...report, changes: "" }));
});

test("Treeherder checks all pages and never passes an empty or pending push", async () => {
  const url = "https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40);
  const visited = [];
  const client = createTreeherderClient({ fetchImpl: async value => {
    visited.push(value);
    const data = value.includes("/push/") ? { results: [{ id: 1 }] }
      : value.includes("offset=0") ? { results: Array.from({ length: 2000 }, (_, id) => ({ id, state: "completed", result: "success" })) }
      : { results: [{ id: 2001, state: "pending", result: "unknown" }] };
    return { ok: true, json: async () => data };
  } });
  const result = await client.inspect(url);
  assert.equal(result.jobs.length, 2001);
  assert.equal(result.complete, false);
  assert.ok(visited.some(item => item.includes("offset=2000")));
  assert.throws(() => parseTryUrl("https://evil.invalid/jobs?repo=try&revision=" + "a".repeat(40)));
});

test("store does not overwrite a corrupt state file with empty state", async t => {
  const { store } = await setup(t);
  await writeFile(path.join(store.directory, "test.json"), "broken");
  assert.throws(() => store.list());
  assert.equal(await readFile(path.join(store.directory, "test.json"), "utf8"), "broken");
});

test("Lando links wait for a revision, then inspect the resulting Treeherder push", async () => {
  let landed = false;
  const visited = [];
  const client = createTreeherderClient({ fetchImpl: async url => {
    visited.push(url);
    const data = url.includes("landing_jobs") ? { status: "submitted", commit_id: landed ? "a".repeat(40) : null }
      : url.includes("/push/") ? { results: [{ id: 1 }] }
      : { results: [{ state: "completed", result: "success" }] };
    return { ok: true, json: async () => data };
  } });
  const url = "https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=123";
  assert.equal((await client.inspect(url)).complete, false);
  landed = true;
  assert.equal((await client.inspect(url)).complete, true);
  assert.ok(visited.includes("https://lando.moz.tools/landing_jobs/123"));
});

test("a newer manual Try supersedes repairs for the same patch", async t => {
  const { store, state } = await setup(t);
  const newer = { ...state, id: "new", phase: "passed", attempts: [{ ...state.attempts[0], createdAt: new Date(100).toISOString() }] };
  store.save(newer);
  await createTryMonitor({ store, repairer: {}, treeherder: { inspect: () => assert.fail("stale run") } }).tick();
  assert.equal(store.read("test").phase, "superseded");
});

test("a slow repair does not block other due checks", async t => {
  const { store, state } = await setup(t, "repairing");
  let finishRepair;
  const pending = new Promise(resolve => { finishRepair = resolve; });
  let checked = false;
  const monitor = createTryMonitor({ store, now: () => 100,
    repairer: { repair: async () => pending },
    treeherder: { inspect: async () => { checked = true; return { jobs: [], failures: [], complete: false }; } } });
  const firstTick = monitor.tick();
  const other = { ...state, id: "other", sourceHash: "other", phase: "waiting" };
  store.save(other);
  await monitor.tick();
  assert.equal(checked, true);
  finishRepair();
  await firstTick;
});

test("older Try records are imported once without inventing submission options", async t => {
  const { store, directory } = await setup(t);
  const { importRecordedTryRuns } = await import("../commands/graph/try-monitor-import.mjs");
  const recordPath = path.join(directory, "old-runs");
  const url = "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=" + "c".repeat(40);
  const olderUrl = url.replace(/c{40}$/, "d".repeat(40));
  await writeFile(recordPath, JSON.stringify({ runs: [
    { id: "old", hash: "old-hash", url, subject: "Old", createdAt: new Date(0).toISOString() },
    { id: "older", hash: "old-hash", url: olderUrl, subject: "Old", createdAt: new Date(0).toISOString() },
  ] }));
  const options = { graphs: [{ path: directory, repository: "comm", label: "comm" }], store,
    runCommand: async () => recordPath };
  await importRecordedTryRuns(options);
  await importRecordedTryRuns(options);
  assert.equal(store.list().length, 3);
  const imported = store.list().find(state => state.imported && state.attempts[0].url === url);
  assert.equal(imported.attempts[0].url, url);
  assert.equal(imported.nextCheckAt, null);
  assert.equal(imported.phase, "paused");
  assert.equal(imported.options, undefined);
});

test("submission recovery uses Treeherder timestamp and ID pagination", async () => {
  const visited = [];
  const client = createTreeherderClient({ fetchImpl: async value => {
    visited.push(value);
    const url = new URL(value);
    assert.equal(url.searchParams.get("push_timestamp__gte"), "100");
    assert.equal(url.searchParams.has("startdate"), false);
    assert.equal(url.searchParams.has("offset"), false);
    const results = url.searchParams.has("id__lt")
      ? [{ id: 1, revision: "a".repeat(40), revisions: [{ comments: "unique-marker" }] }]
      : Array.from({ length: 100 }, (_, i) => ({ id: 200 - i, revisions: [] }));
    return { ok: true, json: async () => ({ results }) };
  } });
  const found = await client.findSubmission("unique-marker", 100000);
  assert.match(found, /revision=a{40}$/);
  assert.ok(visited[1].includes("id__lt=101"));
});

test("a completed decision does not pass while Taskcluster still has pending tasks", async () => {
  const client = createTreeherderClient({ fetchImpl: async url => {
    const data = url.includes("/push/") ? { results: [{ id: 1 }] }
      : url.includes("/jobs/") ? { results: [{ id: 1, task_id: "decision", job_type_name: "Decision Task", state: "completed", result: "success" }] }
      : url.includes("task-group") ? { tasks: [{ status: { taskId: "later", state: "pending" } }] }
      : { taskGroupId: "group" };
    return { ok: true, json: async () => data };
  } });
  const result = await client.inspect("https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40));
  assert.equal(result.complete, false);
});

test("a manual Try on a fixup reuses its repair loop and captures a changed Gecko base", async t => {
  const { store, state, directory } = await setup(t, "passed");
  Object.assign(state, { fixupHash: "fixup", geckoHash: "old-gecko", workspace: "old-workspace", sourceHash: "parent" });
  store.save(state);
  const { prepareMonitoredTry } = await import("../commands/graph/try-submission.mjs");
  const tracking = await prepareMonitoredTry({ graph: { path: directory }, store, options: { artifact: false },
    runCommand: async ({ args, cwd }) => {
      if (args.includes("--show-toplevel")) return directory;
      if (args[0] === "rev-parse") return cwd === directory ? "fixup" : "new-gecko";
      if (args[0] === "show") return "fixup! Feature";
      if (args[0] === "status") return "";
      assert.fail(args.join(" "));
    } });
  tracking.release();
  assert.equal(store.list().length, 1);
  const saved = store.read("test");
  assert.equal(saved.sourceHash, "parent");
  assert.equal(saved.fixupHash, "fixup");
  assert.equal(saved.geckoHash, "new-gecko");
  assert.equal(saved.workspace, "");
  assert.equal(saved.options.artifact, false);
  assert.equal(saved.attempts.length, 2);
});


test("AI-disabled monitoring checks Try status but does not assess or repair failures", async t => {
  const { store } = await setup(t);
  const monitor = createTryMonitor({ store, aiEnabled: false, now: () => 100,
    treeherder: { inspect: async () => failed, compare: () => assert.fail("AI evidence should not be requested") },
    repairer: { assess: () => assert.fail("AI disabled"), repair: () => assert.fail("AI disabled") } });
  await monitor.tick();
  assert.equal(store.read("test").phase, "needs-evidence");
  assert.match(store.read("test").attempts[0].summary, /Enable AI/);
});

for (const phase of ["waiting", "analyzing", "needs-evidence", "repairing", "ready-to-submit", "paused", "passed"]) {
  test(`imported ${phase} runs never check status, assess, repair or submit`, async t => {
    const { store, state } = await setup(t, phase);
    state.imported = true;
    state.attempts[0].resultStatus = "failed";
    state.attempts[0].assessment = assessment("patch");
    store.save(state);
    let calls = 0;
    const unexpected = async () => { calls++; throw new Error("Historical work must not run"); };
    const monitor = createTryMonitor({ store, treeherder: { inspect: unexpected, compare: unexpected },
      repairer: { assess: unexpected, repair: unexpected, submit: unexpected } });
    await monitor.tick();
    await monitor.tick();
    assert.equal(calls, 0);
    assert.deepEqual(store.read(state.id), state);
    assert.equal(monitorRuns(store.read(state.id))[0].status, "patch-failed");
  });
}

test("workflow phase and retry errors do not replace a run's known result", async t => {
  const { state } = await setup(t);
  state.attempts[0].status = "passed";
  state.error = "Temporary network failure";
  for (const phase of ["paused", "superseded", "squashed", "repairing"]) {
    state.phase = phase;
    assert.equal(monitorRuns(state)[0].status, "passed");
  }
  state.attempts[0].status = "waiting";
  state.phase = "superseded";
  assert.equal(monitorRuns(state)[0].status, "waiting");
  state.phase = "waiting";
  assert.equal(monitorRuns(state)[0].status, "waiting");
});

test("completed failures remain visible separately from cause assessment and reruns", async t => {
  const { state } = await setup(t, "analyzing");
  const attempt = state.attempts[0];
  attempt.status = "waiting";
  attempt.resultStatus = "failed";
  attempt.statusComplete = true;
  assert.equal(monitorRuns(state)[0].status, "failed-unclassified");
  state.phase = "needs-evidence";
  assert.equal(monitorRuns(state)[0].status, "failed-unclassified");
  attempt.assessment = assessment("unknown");
  assert.equal(monitorRuns(state)[0].status, "failed-unclassified");
  attempt.assessment = assessment("unrelated");
  assert.equal(monitorRuns(state)[0].status, "passed");
  attempt.assessment = assessment("patch");
  assert.equal(monitorRuns(state)[0].status, "patch-failed");
  state.assessment = attempt.assessment;
  addTryAttempt(state);
  state.attempts.at(-1).url = "new-run";
  assert.equal(monitorRuns(state)[1].status, "waiting");
  assert.equal(monitorRuns(state)[1].assessment, undefined);
});

test("failed dependencies finish blocked task chains but runnable work still waits", async () => {
  for (const requires of ["all-completed", "all-resolved"]) {
    const client = createTreeherderClient({ fetchImpl: async url => {
      const data = url.includes("/push/") ? { results: [{ id: 1 }] }
        : url.includes("/jobs/") ? { results: [
          { id: 1, task_id: "decision", job_type_name: "Decision Task", state: "completed", result: "success" },
          { id: 2, task_id: "package", state: "unscheduled", result: "unknown" },
        ] }
        : url.includes("task-group") ? { tasks: [
          { status: { taskId: "package", state: "unscheduled" }, task: { requires, dependencies: ["build"] } },
          { status: { taskId: "dependent", state: "unscheduled" }, task: { dependencies: ["package"] } },
          { status: { taskId: "build", state: "failed" }, task: { metadata: { name: "Build" } } },
        ] } : { taskGroupId: "group" };
      return { ok: true, json: async () => data };
    } });
    const result = await client.inspect("https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40));
    assert.equal(result.complete, requires === "all-completed");
    assert.deepEqual(result.failures.map(job => job.task_id), ["build"]);
  }
});

test("completed failures proceed through assessment, repair and resubmission", async t => {
  const { store } = await setup(t);
  const calls = [];
  await createTryMonitor({ store, now: () => 100,
    treeherder: { inspect: async () => failed, compare: async () => evidence },
    repairer: {
      assess: async () => { calls.push("assess"); return assessment("patch"); },
      repair: async state => { calls.push("repair"); state.phase = "ready-to-submit"; },
      submit: async state => { calls.push("submit"); addTryAttempt(state); state.phase = "waiting"; },
    } }).tick();
  assert.deepEqual(calls, ["assess", "repair", "submit"]);
  assert.equal(store.read("test").attempts[0].resultStatus, "failed");
});

for (const fails of [true]) {
  test(`status polling ${fails ? "retries failed assessments" : "waits for new evidence"} after restart`, async t => {
    const { store } = await setup(t);
    let time = 100, assessments = 0, inspections = 0;
    const options = { store, now: () => time,
      treeherder: { inspect: async () => { inspections++; return failed; }, compare: async () => evidence },
      repairer: { assess: async () => {
        assessments++;
        if (fails) throw new Error("Usage limit reached");
        return assessment("unknown");
      } } };
    await createTryMonitor(options).tick();
    for (let index = 0; index < 3; index++) {
      time += TRY_CHECK_INTERVAL_MS;
      await createTryMonitor(options).tick();
    }
    assert.equal(inspections, 4);
    assert.equal(assessments, fails ? 4 : 1);
    assert.equal(store.read("test").phase, "needs-evidence");
  });
}

test("analysis immediately continues diagnosis, repair and submission without a timer", async t => {
  const { store } = await setup(t);
  const calls = [];
  await createTryMonitor({ store, now: () => 100,
    treeherder: { inspect: async () => failed, compare: async () => evidence },
    repairer: {
      assess: async () => { calls.push("assess"); return assessment("unknown"); },
      repair: async state => {
        calls.push("diagnose and repair current code");
        state.attempts[0].assessment = assessment("patch");
        state.phase = "ready-to-submit";
      },
      submit: async state => { calls.push("submit"); addTryAttempt(state, 100); state.attempts.at(-1).url = "next"; state.phase = "waiting"; },
    },
  }).tick();
  assert.deepEqual(calls, ["assess", "diagnose and repair current code", "submit"]);
  const runs = monitorRuns(store.read("test"));
  assert.equal(runs[0].status, "patch-failed");
  assert.equal(runs[0].retryUrl, "next");
  assert.equal(runs[1].status, "waiting");
});

test("failed pills retain the verdict while reporting repair activity", async t => {
  const { state } = await setup(t, "repairing");
  state.attempts[0].assessment = assessment("patch");
  for (const command of ["../mach test mail/test.js", "node --test test/file.mjs", "pytest test.py"]) {
    state.repairActivity = getTryRepairActivity({ method: "item/started", params: { item: { type: "commandExecution", command } } });
    assert.equal(monitorRuns(state)[0].activity, "Running tests");
    assert.equal(monitorRuns(state)[0].status, "patch-failed");
  }
  state.repairActivity = getTryRepairActivity({ method: "item/completed", params: { item: { type: "commandExecution" } } });
  assert.equal(monitorRuns(state)[0].activity, "Working");
});

test("fixup commits show their pending Try and own history without inheriting the parent verdict", async t => {
  const { state } = await setup(t);
  state.sourceHash = state.hash = "parent";
  state.fixupHash = "fixup-new";
  state.attempts = [
    { id: "parent", hash: "parent", url: "https://example.com/parent", createdAt: new Date(0).toISOString(), assessment: assessment("patch") },
    { id: "old-fixup", hash: "fixup-old", url: "https://example.com/old", createdAt: new Date(1000).toISOString(), assessment: assessment("patch") },
    { id: "new-fixup", hash: "fixup-new", url: "https://example.com/new", createdAt: new Date(2000).toISOString(), status: "waiting" },
  ];
  const store = { runs: monitorRuns(state) };
  const graph = { label: "comm", path: state.path };
  const parent = await getGraphTryRunsForCommit({ graph, commit: { hash: "parent", subject: state.subject }, store });
  const fixup = await getGraphTryRunsForCommit({ graph, commit: { hash: "fixup-new", subject: "fixup! " + state.subject }, store });
  assert.deepEqual(parent.map(run => run.id), ["parent"]);
  assert.equal(parent[0].status, "patch-failed");
  assert.equal(parent[0].activity, "");
  assert.deepEqual(fixup.map(run => run.id), ["new-fixup", "old-fixup"]);
  assert.equal(fixup[0].status, "waiting");
  assert.equal(fixup[0].stale, undefined);
  assert.equal(fixup[1].status, "patch-failed");
  assert.equal(fixup[1].stale, true);
});

test("only the newest attempt is inspected; older completed failures cannot start AI", async t => {
  const { store, state } = await setup(t);
  state.attempts.push({ id: "pending", url: "latest", createdAt: new Date(2000).toISOString() });
  store.save(state);
  const monitor = createTryMonitor({ store, treeherder: {
    inspect: async url => { assert.equal(url, "latest"); return { jobs: [{}], complete: false, failures: [{ id: "failed-early" }] }; },
    compare: () => assert.fail("Pending runs must not collect AI evidence"),
  }, repairer: { assess: () => assert.fail("No AI for pending runs"), repair: () => assert.fail("No repair") } });
  await monitor.tick();
  assert.equal(store.read(state.id).phase, "waiting");
});

test("a newer Try posted during evidence collection prevents an outdated AI assessment", async t => {
  const { store, state } = await setup(t);
  const monitor = createTryMonitor({ store, treeherder: {
    inspect: async () => failed,
    compare: async () => {
      store.save({ ...state, id: "newer", attempts: [{ id: "new", url: "new", createdAt: new Date(1000).toISOString() }], nextCheckAt: 999999 });
      return evidence;
    },
  }, repairer: { assess: () => assert.fail("The older Try must not start AI") } });
  await monitor.tick();
  assert.equal(store.read(state.id).phase, "superseded");
});


test("pending Try status is checked each minute without starting AI", async t => {
  const { store } = await setup(t);
  let time = 0, inspections = 0;
  const saved = store.read("test");
  saved.nextCheckAt = TRY_CHECK_INTERVAL_MS;
  store.save(saved);
  const monitor = createTryMonitor({ store, now: () => time, repairer: {
    assess: () => assert.fail("pending Try must not start AI"), repair: () => assert.fail("pending Try must not repair"),
  }, treeherder: { inspect: async () => { inspections++; return { complete: false, jobs: [{}], failures: [] }; } } });
  await monitor.tick(); assert.equal(inspections, 0);
  time = TRY_STATUS_CHECK_INTERVAL_MS;
  await monitor.tick(); assert.equal(inspections, 1);
  assert.equal(store.read("test").nextCheckAt, time + TRY_STATUS_CHECK_INTERVAL_MS);
  time++; await monitor.tick(); assert.equal(inspections, 1);
  time += TRY_STATUS_CHECK_INTERVAL_MS;
  await monitor.tick(); assert.equal(inspections, 2);
});

test("unrelated failures cannot pass a Try when every build failed", async t => {
  const { store } = await setup(t);
  const monitor = createTryMonitor({ store, treeherder: {
    inspect: async () => ({ ...failed, jobs: [{ id: "job", job_type_name: "build-linux64/opt", state: "completed", result: "busted" }] }),
    compare: async () => evidence,
  }, repairer: { assess: async () => assessment("unrelated") } });
  await monitor.tick();
  const saved = store.read("test");
  assert.equal(saved.phase, "build-blocked");
  assert.equal(saved.attempts[0].resultStatus, "failed");
  assert.equal(monitorRuns(saved)[0].status, "build-blocked");
  assert.equal(saved.attempts[0].buildValidationBlocked, true);
  assert.match(saved.attempts[0].summary, /No build completed successfully/);
  await monitor.tick();
  assert.equal(store.read("test").attempts[0].assessmentAttempts, 1);
});


test("an unrelated test failure can pass after a successful build", async t => {
  const { store } = await setup(t);
  const monitor = createTryMonitor({ store, treeherder: {
    inspect: async () => ({ ...failed, jobs: [
      { id: "build", job_type_name: "build-linux64/opt", state: "completed", result: "success" },
      { id: "job", job_type_name: "test-linux64/opt", state: "completed", result: "testfailed" },
    ] }),
    compare: async () => evidence,
  }, repairer: { assess: async () => assessment("unrelated") } });
  await monitor.tick();
  const saved = store.read("test");
  assert.equal(saved.attempts[0].buildValidationBlocked, false);
  assert.equal(saved.phase, "passed");
  assert.equal(monitorRuns(saved)[0].status, "passed");
});

test("a saved false Pass with no successful build is shown as blocked", async t => {
  const { store } = await setup(t);
  const state = store.read("test");
  Object.assign(state.attempts[0], { status: "passed", determinedVerdict: "passed", statusComplete: true,
    resultStatus: "failed", buildValidationBlocked: true, assessment: assessment("unrelated") });
  state.phase = "passed";
  store.save(state);
  assert.equal(monitorRuns(store.read("test"))[0].status, "build-blocked");
});

test("durable automation suspension still permits status reads but no AI", async t => {
  const { store, directory } = await setup(t);
  await writeFile(path.join(directory, ".automation-paused"), "audit");
  const monitor = createTryMonitor({ store, treeherder: { inspect: async () => failed,
    compare: () => assert.fail("no evidence or model work while suspended") },
  repairer: { assess: () => assert.fail("AI suspended") } });
  await monitor.tick();
  assert.equal(store.read("test").attempts[0].statusComplete, true);
  assert.equal(monitorRuns(store.read("test"))[0].status, "failed-unclassified");
});


for (const graphs of [[], [{ path: "/another/checkout" }]]) test(`monitor ignores saved runs outside its configured checkouts: ${JSON.stringify(graphs)}`, async t => {
  const { store, state } = await setup(t);
  const unexpected = () => assert.fail("unrelated checkout must not be polled or sent to AI");
  const monitor = createTryMonitor({ graphs, store, treeherder: { inspect: unexpected }, repairer: { assess: unexpected } });
  await monitor.tick();
  assert.deepEqual(store.read(state.id), state);
});

test("patch-caused Rust failure waits for an update after attribution", async t => {
  const { store } = await setup(t);
  let time = 100;
  let checks = 0;
  const job = { id: "rust", job_type_name: "build-linux64/opt", state: "completed", result: "busted" };
  const monitor = createTryMonitor({ store, now: () => time,
    treeherder: {
      inspect: async () => ({ complete: true, repo: "try-comm-central", jobs: [job], failures: [job] }),
      evidence: async () => ({ id: "rust", logs: [{ url: "raw-log", text: "Rust dependencies are out of sync. Run mach tb-rust vendor." }] }),
      compare: async () => ({ failures: [{ id: "rust" }], baseline: [] }),
    },
    rustOriginCheck: async () => ({ available: ++checks > 1 }),
    repairer: { assess: async () => ({ failures: [{ ...assessment("patch").failures[0], id: "rust" }] }), repair: () => assert.fail("no repair"), submit: () => assert.fail("no retry") },
  });
  await monitor.tick();
  let saved = store.read("test");
  assert.equal(saved.phase, "rust-blocked");
  assert.equal(monitorRuns(saved)[0].status, "patch-failed");
  assert.equal(saved.attempts[0].rustFailure.url, "raw-log");
  assert.equal(checks, 0);
  time += TRY_CHECK_INTERVAL_MS;
  await monitor.tick();
  saved = store.read("test");
  assert.equal(saved.attempts[0].rustOrigin.available, false);
  time += TRY_CHECK_INTERVAL_MS;
  await monitor.tick();
  saved = store.read("test");
  assert.equal(saved.attempts[0].rustOrigin.available, true);
  assert.equal(saved.phase, "rust-blocked", "An origin update must be rebased before retrying");
  assert.match(saved.error, /Rebase/);
  assert.equal(saved.attempts.length, 1);
});

test("restart resumes unresolved diagnosis immediately despite its old evidence timer", async t => {
  const { store, state } = await setup(t, "needs-evidence");
  state.attempts[0].assessment = assessment("unknown");
  state.evidence = evidence;
  state.nextCheckAt = Date.now() + 30 * 60 * 1000;
  store.save(state);
  let repaired = false;
  await createTryMonitor({ store,
    treeherder: { inspect: async () => failed, compare: () => assert.fail("Do not re-fetch unchanged evidence") },
    repairer: { assess: () => assert.fail("Do not repeat assessment"), repair: async current => { assert.equal(current.workerPid, process.pid); repaired = true; } },
  }).tick();
  assert.equal(repaired, true);
  assert.equal(store.read(state.id).workerPid, undefined);
});

test("new Try preserves each determined historical verdict, including imported history", async t => {
  const { state } = await setup(t);
  state.attempts[0].assessment = assessment("unrelated");
  const second = addTryAttempt(state, 1000);
  second.url = "second";
  second.assessment = assessment("patch");
  const third = addTryAttempt(state, 2000);
  third.url = "third";
  state.phase = "analyzing";
  assert.deepEqual(monitorRuns(state).map(run => run.status), ["passed", "patch-failed", "analyzing"]);
  assert.deepEqual(monitorRuns(state).slice(0, 2).map(run => run.activity), ["", ""]);
  state.imported = true;
  assert.deepEqual(monitorRuns(state).map(run => run.status), ["passed", "patch-failed", "unknown"]);
});

test("Comm-Central Broken requires failed upstream builds and unrelated attribution", () => {
  const value = { ...assessment("unrelated"), failureCategory: "comm-central" };
  assert.throws(() => validateTryAssessment(value, evidence), /comm-central build evidence/);
  const upstream = { ...evidence, baseline: [{ repo: "comm-central", failures: [{ job: "build-linux64/opt" }] }] };
  assert.equal(validateTryAssessment(value, upstream).failureCategory, "comm-central");
  assert.throws(() => validateTryAssessment({ ...value, failures: assessment("patch").failures }, upstream), /comm-central build evidence/);
});

test("Rust failures wait for compatible origin updates regardless of branch changes", async t => {
  const { store, state } = await setup(t, "rust-blocked");
  state.attempts[0].rustFailure = { signature: "Rust dependencies are out of sync" };
  store.save(state);
  let checked = false;
  await createTryMonitor({ store, rustOriginCheck: async () => { checked = true; return { available: false }; },
    repairer: { assess: () => assert.fail("No AI needed for known Rust mismatch") } }).tick();
  assert.equal(checked, true);
  assert.equal(monitorRuns(store.read(state.id))[0].status, "patch-failed");
});

test("restart completes saved unrelated failures without another worker or retry delay", async t => {
  const { store, state } = await setup(t, "repairing");
  Object.assign(state, { error: "The repair must list each source file to commit.", nextCheckAt: 999999 });
  Object.assign(state.attempts[0], { statusComplete: true, failedJobCount: 1, assessment: assessment("unrelated") });
  store.save(state);
  await createTryMonitor({ store, now: () => 100, treeherder: {}, repairer: {} }).tick();
  const saved = store.read(state.id);
  assert.equal(saved.phase, "passed");
  assert.equal(saved.error, undefined);
  assert.equal(saved.nextCheckAt, null);
  assert.equal(monitorRuns(saved)[0].status, "passed");
});

test("interrupted diagnosis resumes before its old timer and reuses gathered evidence", async t => {
  const { store, state } = await setup(t, "analyzing");
  Object.assign(state, { error: "Codex App Server was stopped. The saved session can be resumed.", nextCheckAt: 999999 });
  store.save(state);
  let comparisons = 0, assessments = 0;
  const create = time => createTryMonitor({ store, now: () => time,
    treeherder: { inspect: async () => failed, compare: async () => { comparisons++; return evidence; } },
    repairer: { assess: async () => { if (++assessments === 1) throw new Error("temporary failure"); return assessment("unrelated"); } } });
  await create(100).tick();
  await create(999999).tick();
  assert.equal(assessments, 2);
  assert.equal(comparisons, 1);
  assert.equal(store.read(state.id).phase, "passed");
});

test("only one started monitor owns saved work and another takes over after stop", async t => {
  const { store } = await setup(t);
  let first = 0, second = 0;
  const make = count => createTryMonitor({ store, tickIntervalMs: 5, now: () => 100, repairer: {},
    treeherder: { inspect: async () => { count(); return { jobs: [], failures: [], complete: false }; } } });
  const a = make(() => first++), b = make(() => second++);
  t.after(async () => { await a.stop(); await b.stop(); });
  a.start(); b.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(first, 1); assert.equal(second, 0);
  await a.stop();
  const saved = store.read("test"); saved.nextCheckAt = 0; store.save(saved);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(second, 1);
  await b.stop();
});

test("status snapshots keep comparison evidence outside the workflow record", async t => {
  const { store, state } = await setup(t);
  state.evidence = evidence;
  store.save(state);
  const raw = JSON.parse(await readFile(path.join(store.directory, 'test.json'), 'utf8'));
  assert.equal(raw.evidence, undefined);
  assert.ok(raw.evidenceFile);
  const saved = store.read('test');
  assert.equal(JSON.stringify(saved).includes('baseline'), false);
  assert.deepEqual(saved.evidence, evidence);
  saved.evidence = { failures: [], baseline: [] };
  store.save(saved);
  assert.deepEqual(store.read('test').evidence, { failures: [], baseline: [] });
});
