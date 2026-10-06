import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTreeherderClient } from "../commands/graph/treeherder.mjs";

 test("evidence uses complete raw logs, intermittent suggestions and recent runs from every repository", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const fullLog = "failure context\n".repeat(10000) + "final failure line\n";
  const rawUrl = "https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/task/runs/0/artifacts/public/logs/live_backing.log";
  const job = { id: 1, task_id: "task", job_type_name: "test", platform: "linux", platform_option: "opt", state: "completed", result: "testfailed" };
  const suggestions = [{ search: "final failure line", bugs: { open_recent: [{ id: 123, summary: "Intermittent final failure line" }] } }];
  const client = createTreeherderClient({ evidenceDirectory: directory, fetchImpl: async value => {
    const url = new URL(value);
    requests.push(value);
    if (value === rawUrl) return { ok: true, text: async () => fullLog };
    let data;
    if (url.pathname.endsWith("bug_suggestions/")) data = suggestions;
    else if (/\/jobs\/\d+\/$/.test(url.pathname)) data = { logs: [{ name: "live_backing_log", url: rawUrl }] };
    else if (url.pathname.endsWith("/push/")) {
      assert.equal(url.searchParams.get("count"), "50");
      data = { results: Array.from({ length: 50 }, (_, i) => ({ id: i + 2, revision: `baseline-${i}`, author: i % 2 ? "other" : "self" })) };
    }
    else if (url.pathname.endsWith("/jobs/")) data = { results: url.searchParams.get("push_id") === "51" ? [{ ...job, job_type_name: "other-build", platform: "macos", platform_option: "debug" }] : [] };
    else if (url.pathname.endsWith("/status")) data = { status: { runs: [{ reasonResolved: "intermittent-task" }] } };
    else data = { metadata: {}, payload: { env: { USE_ARTIFACT: "0" } }, dependencies: [] };
    return { ok: true, json: async () => data };
  } });
  const result = await client.compare({ repo: "try-comm-central", push: { id: 1 }, failures: [job] });
  assert.equal(result.baseline.length, 150);
  assert.deepEqual(result.baseline.filter(item => item.failures.length).map(item => item.repo), ["comm-central", "try-comm-central", "try"]);
  assert.deepEqual(new Set(result.baseline.map(item => item.author)), new Set(["self", "other"]));
  const failure = result.failures[0];
  assert.deepEqual(failure.suggestions, suggestions);
  assert.equal(failure.taskStatus.status.runs[0].reasonResolved, "intermittent-task");
  assert.equal(failure.logs[0].truncated, true);
  assert.equal(await readFile(failure.logs[0].fullLogPath, "utf8"), fullLog);
  assert.equal(requests.filter(value => value === rawUrl).length, 1);
  assert.ok(requests.every(value => new URL(value).pathname.startsWith("/api/")));
});


test("missing optional logs and metadata retain the available complete raw log", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-evidence-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = "https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/task";
  const client = createTreeherderClient({ evidenceDirectory: directory, fetchImpl: async url => {
    if (url.endsWith("/jobs/1/")) return { ok: true, json: async () => ({ logs: [
      { name: "errorsummary_json", url: `${prefix}/missing` },
      { name: "live_backing_log", url: `${prefix}/raw` },
    ] }) };
    if (url.endsWith("/raw")) return { ok: true, text: async () => "TEST-UNEXPECTED-FAIL actual failure" };
    return { ok: false, status: 404 };
  } });
  const result = await client.evidence("try-comm-central", { id: 1, task_id: "task" });
  assert.equal(result.logs.length, 1);
  assert.match(await readFile(result.logs[0].fullLogPath, "utf8"), /actual failure/);
  assert.equal(result.unavailableEvidence.length, 4);
  assert.equal(result.task, null);
});

test("startup profiles are downloaded, decoded and cached for workers without network access", async t => {
  const { gzipSync } = await import("node:zlib");
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = "https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/task/runs/0/artifacts";
  let downloads = 0;
  const profile = { threads: [{ name: "GeckoMain" }] };
  const client = createTreeherderClient({ evidenceDirectory: directory, fetchImpl: async url => {
    if (url.endsWith("live_backing.log")) return { ok: true, text: async () => "TEST-UNEXPECTED-TIMEOUT | startup | application timed out" };
    if (url.endsWith("profile_0_1.json.gz")) { downloads++; return { ok: true, arrayBuffer: async () => gzipSync(JSON.stringify(profile)) }; }
    let data = {};
    if (url.endsWith("/jobs/1/")) data = { logs: [{ name: "live_backing_log", url: base + "/public/logs/live_backing.log" }] };
    else if (url.endsWith("bug_suggestions/")) data = [];
    else if (url === base) data = { artifacts: [{ name: "public/test_info/profile_0_1.json.gz" }] };
    return { ok: true, json: async () => data };
  } });
  const job = { id: 1, task_id: "task", retry_id: 0, job_type_name: "test-macos" };
  for (let index = 0; index < 2; index++) {
    const evidence = await client.evidence("try-comm-central", job);
    const diagnostic = evidence.logs.find(log => log.name === "startup_profile");
    assert.deepEqual(JSON.parse(await readFile(diagnostic.fullLogPath, "utf8")), profile);
  }
  assert.equal(downloads, 1);
});

test("comparison keeps service errors as evidence gaps and reuses completed pushes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-evidence-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let jobLists = 0;
  const client = createTreeherderClient({ evidenceDirectory: directory, fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/push/')) return { ok: true, json: async () => ({results:[{id:1,revision:'one'},{id:2,revision:'two'}]}) };
    if (url.pathname.endsWith('/jobs/')) {
      jobLists++;
      if (url.searchParams.get('push_id') === '2') return {ok:false,status:503};
      return {ok:true,json:async()=>({results:[{id:1,state:'completed',result:'success'}]})};
    }
    throw new Error(`Unexpected request ${value}`);
  }});
  const first = await client.compare({repo:'target',failures:[]});
  assert.equal(first.baseline.length,6);
  assert.equal(first.baseline.filter(push=>push.unavailableEvidence?.length).length,3);
  const second = await client.compare({repo:'target',failures:[]});
  assert.equal(second.baseline.length,6);
  assert.equal(jobLists,9, 'the three completed pushes must not be fetched again');
});

test("completed job evidence survives restart even before its push completes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-job-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const fetchImpl = async url => { requests++; return { ok: true, json: async () => url.endsWith('bug_suggestions/') ? [] : {logs:[]} }; };
  const job = {id:42, state:'completed', result:'testfailed', retry_id:0};
  await createTreeherderClient({evidenceDirectory:directory,fetchImpl}).evidence('try',job);
  const first = requests;
  await createTreeherderClient({evidenceDirectory:directory,fetchImpl}).evidence('try',job);
  assert.equal(requests,first);
  await createTreeherderClient({evidenceDirectory:directory,fetchImpl}).evidence('try',{...job,retry_id:1});
  assert.ok(requests > first, 'a different retry needs fresh evidence');
});

test("completed evidence stays cached forever, including unavailable logs", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-partial-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (url.endsWith('/jobs/1/')) return { ok: true, json: async () => ({logs:[]}) };
    return { ok: false, status:404 };
  };
  const job = {id:1,state:'completed',result:'testfailed'};
  const client = createTreeherderClient({evidenceDirectory:directory,fetchImpl});
  const first = await client.evidence('try',job);
  assert.ok(first.unavailableEvidence.length);
  const requested = calls;
  const again = await createTreeherderClient({evidenceDirectory:directory,fetchImpl}).evidence('try',job);
  assert.deepEqual(again,JSON.parse(JSON.stringify(first)));
  assert.equal(calls,requested);
  const {readdir,writeFile} = await import('node:fs/promises');
  const file = path.join(directory,(await readdir(directory)).find(name=>name.startsWith('job-')));
  const cached = JSON.parse(await readFile(file,'utf8')); cached.collectedAt = 0;
  await writeFile(file,JSON.stringify(cached));
  await client.evidence('try',job);
  assert.equal(calls,requested);
});
