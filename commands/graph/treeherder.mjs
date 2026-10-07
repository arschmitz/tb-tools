import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TREEHERDER = "https://treeherder.mozilla.org";
const LANDO_INSTANCES = {
  "lando-prod": "https://api.lando.services.mozilla.com",
  "lando-prod-2025": "https://lando.moz.tools",
  "lando-dev": "https://api.dev.lando.nonprod.cloudops.mozgcp.net",
  "lando-dev-2025": "https://lando-dev.allizom.org",
};
const TASKCLUSTER = "https://firefox-ci-tc.services.mozilla.com";

export function parseTryUrl(value) {
  const url = new URL(value);
  const repo = url.searchParams.get("repo");
  const revision = url.searchParams.get("revision");
  const landoCommitID = url.searchParams.get("landoCommitID");
  const landoInstance = url.searchParams.get("landoInstance");
  const validLando = /^\d+$/.test(landoCommitID || "") && Object.hasOwn(LANDO_INSTANCES, landoInstance || "");
  if (url.origin !== TREEHERDER || !["try", "try-comm-central"].includes(repo) || (!/^[a-f0-9]{12,64}$/.test(revision || "") && !validLando)) {
    throw new Error("Try output did not contain a valid Treeherder revision URL.");
  }
  return { repo, revision, landoCommitID, landoInstance };
}

export function createTreeherderClient({ fetchImpl = fetch, signal,
  evidenceDirectory = path.join(os.homedir(), ".tb-tools", "try-evidence") } = {}) {
  async function get(url, json = true) {
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    if (!response.ok) throw Object.assign(new Error(`Treeherder request failed (${response.status}): ${url}`), { status: response.status });
    return json ? response.json() : response.text();
  }
  async function pushes(repo, params = {}) {
    const data = await get(`${TREEHERDER}/api/project/${repo}/push/?${new URLSearchParams({ count: "5", ...params })}`);
    if (!Array.isArray(data.results)) throw new Error("Treeherder returned an invalid push list.");
    return data.results;
  }
  async function jobs(repo, pushId) {
    const results = [];
    for (let offset = 0; ; offset += 2000) {
      const data = await get(`${TREEHERDER}/api/project/${repo}/jobs/?push_id=${pushId}&count=2000&offset=${offset}`);
      if (!Array.isArray(data.results)) throw new Error("Treeherder returned an invalid job list.");
      results.push(...data.results);
      if (data.results.length < 2000) break;
      if (offset >= 100000) throw new Error("Treeherder job list is too large. No pass result was recorded.");
    }
    return results;
  }
  async function evidence(repo, job) {
    // Completed job IDs identify immutable logs. Include the retry and result
    // so a different execution cannot reuse the wrong evidence.
    const key = createHash("sha256").update(JSON.stringify([repo, job.id, job.task_id, job.retry_id, job.result])).digest("hex");
    const file = path.join(evidenceDirectory, `job-${key}.json`);
    const cacheable = job.state === "completed";
    if (cacheable) {
      try {
        const cached = JSON.parse(await readFile(file, "utf8"));
        return cached.cacheVersion ? cached.evidence : cached;
      }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const result = await collectEvidence(repo, job);
    if (cacheable) {
      await mkdir(evidenceDirectory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ cacheVersion: 1, collectedAt: Date.now(), evidence: result }), { mode: 0o600 });
      await rename(temporary, file);
    }
    return result;
  }

  async function collectEvidence(repo, job) {
    let detail;
    let suggestions = [];
    const unavailableEvidence = [];
    const optional = async (url, json = true) => {
      try { return await get(url, json); }
      catch (error) {
        if (signal?.aborted || (error.status !== 404 && error.status !== 429 && !(error.status >= 500))) throw error;
        unavailableEvidence.push({ url, error: error.message });
        return null;
      }
    };
    if (String(job.id).startsWith("task:")) {
      const artifacts = await get(`${TASKCLUSTER}/api/queue/v1/task/${job.task_id}/runs/${job.retry_id}/artifacts`);
      detail = { logs: (artifacts.artifacts || []).filter(artifact => /(?:errorsummary\.log|live_backing\.log)$/.test(artifact.name))
        .map(artifact => ({ name: artifact.name.endsWith("errorsummary.log") ? "errorsummary_json" : "live_backing_log",
          url: `${TASKCLUSTER}/api/queue/v1/task/${job.task_id}/runs/${job.retry_id}/artifacts/${artifact.name}` })) };
    } else {
      detail = await get(`${TREEHERDER}/api/project/${repo}/jobs/${job.id}/`);
      suggestions = await optional(`${TREEHERDER}/api/project/${repo}/jobs/${job.id}/bug_suggestions/`) || [];
      if (!Array.isArray(suggestions)) throw new Error("Treeherder returned invalid intermittent suggestions.");
    }
    const logs = (detail.logs || []).filter(log => ["errorsummary_json", "live_backing_log"].includes(log.name));
    const output = [];
    for (const log of logs) {
      if (new URL(log.url).origin !== TASKCLUSTER) continue;
      // The read-only AI worker can read these complete local logs even when
      // its own network access is unavailable. Keep the prompt excerpts small.
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const fullLogPath = path.join(evidenceDirectory, createHash("sha256").update(log.url).digest("hex") + ".log");
      try { await access(fullLogPath); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const response = await fetchImpl(log.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
        if (!response.ok) {
          unavailableEvidence.push({ url: log.url, error: `Log download failed (${response.status})` });
          continue;
        }
        const temporary = `${fullLogPath}.${randomUUID()}.tmp`;
        if (response.body) await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
        else await writeFile(temporary, await response.text(), { mode: 0o600 });
        await rename(temporary, fullLogPath);
      }
      // Read one line at a time. Some raw logs are hundreds of megabytes.
      let selected = "", truncated = false, previous = "";
      const lines = createInterface({ input: createReadStream(fullLogPath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (log.name === "errorsummary_json" || /error|fail|unexpected|artifact|GECKO_HEAD_REV|COMM_HEAD_REV|USE_ARTIFACT/i.test(line) || /error|fail|unexpected/i.test(previous)) {
          const available = 80000 - selected.length;
          if (line.length + 1 > available) truncated = true;
          if (available > 0) selected += (line + "\n").slice(0, available);
        }
        previous = line;
      }
      output.push({ url: log.url, name: log.name, text: selected, truncated, fullLogPath });
    }
    // Startup hangs often need profiler stacks. Download the diagnostic through
    // the console, just like logs, so a read-only worker need not fetch it.
    if (/^[\w-]+$/.test(job.task_id || "") && output.some(log =>
      /TEST-UNEXPECTED-TIMEOUT|application timed out|No output received|370 seconds/i.test(log.text))) {
      const run = Number.isInteger(Number(job.retry_id)) ? Number(job.retry_id) : 0;
      const artifacts = await optional(`${TASKCLUSTER}/api/queue/v1/task/${job.task_id}/runs/${run}/artifacts`);
      const profile = artifacts?.artifacts?.find(artifact => /^public\/test_info\/profile_[^/]+\.json\.gz$/.test(artifact.name));
      if (profile) {
        const url = `${TASKCLUSTER}/api/queue/v1/task/${job.task_id}/runs/${run}/artifacts/${profile.name}`;
        const fullLogPath = path.join(evidenceDirectory, createHash("sha256").update(url).digest("hex") + ".json");
        try {
          try { await readFile(fullLogPath); } catch (error) {
            if (error.code !== "ENOENT") throw error;
            const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
            if (!response.ok) throw new Error(`Diagnostic download failed (${response.status}): ${url}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
            JSON.parse(decoded.toString("utf8"));
            const temporary = `${fullLogPath}.${randomUUID()}.tmp`;
            await writeFile(temporary, decoded, { mode: 0o600 });
            await rename(temporary, fullLogPath);
          }
          output.push({ name: "startup_profile", url, fullLogPath, truncated: false,
            text: "Complete decoded startup profile is available locally. Use a script to inspect relevant thread stacks and markers; do not print the entire JSON." });
        } catch (error) { unavailableEvidence.push({ url, error: error.message }); }
      }
    }
    let task = null;
    let taskStatus = null;
    if (/^[\w-]+$/.test(job.task_id || "")) {
      task = await optional(`${TASKCLUSTER}/api/queue/v1/task/${job.task_id}`);
      if (task) task = { metadata: task.metadata, env: task.payload?.env, dependencies: task.dependencies };
      taskStatus = await optional(`${TASKCLUSTER}/api/queue/v1/task/${job.task_id}/status`);
    }
    return { id: String(job.id), job: job.job_type_name, platform: job.platform,
      option: job.platform_option, result: job.result, task, taskStatus, logs: output, suggestions, unavailableEvidence,
      url: `${TREEHERDER}/jobs?repo=${repo}&selectedJob=${job.id}` };
  }
  return {
    pushes, jobs, evidence,
    async inspect(url) {
      let { repo, revision, landoCommitID, landoInstance } = parseTryUrl(url);
      if (!revision && landoCommitID) {
        const landing = await get(`${LANDO_INSTANCES[landoInstance]}/landing_jobs/${landoCommitID}`);
        revision = landing.commit_id;
        if (!revision) return { repo, jobs: [], failures: [], complete: false,
          submissionFailed: ["failed", "cancelled"].includes(String(landing.status).toLowerCase()),
          summary: `Lando: ${landing.status || "waiting"}. ${landing.error || ""}` };
        if (!/^[a-f0-9]{12,64}$/.test(revision)) throw new Error("Lando returned an invalid revision.");
      }
      const push = (await pushes(repo, { revision }))[0];
      if (!push) return { repo, revision, jobs: [], complete: false, failures: [] };
      const allJobs = await jobs(repo, push.id);
      let groupComplete = true;
      const blocked = new Set();
      const decision = allJobs.find(job => /decision/i.test(job.job_type_name || "") && job.task_id);
      if (decision) {
        const task = await get(`${TASKCLUSTER}/api/queue/v1/task/${decision.task_id}`);
        const group = task.taskGroupId;
        if (!/^[\w-]+$/.test(group || "")) throw new Error("The decision task has no valid task group.");
        let token = "";
        const tasks = [];
        do {
          const page = await get(`${TASKCLUSTER}/api/queue/v1/task-group/${group}/list${token ? "?continuationToken=" + encodeURIComponent(token) : ""}`);
          if (!Array.isArray(page.tasks)) throw new Error("Taskcluster returned an incomplete task group.");
          tasks.push(...page.tasks);
          token = page.continuationToken || "";
        } while (token);
        const failedDependencies = new Set(tasks.filter(entry => ["failed", "exception"].includes(entry.status?.state)).map(entry => entry.status.taskId));
        // Tasks that require successful dependencies cannot start after a dependency
        // fails. Follow this through the group instead of waiting for their deadlines.
        let changed;
        do {
          changed = false;
          for (const entry of tasks) {
            if (entry.status?.state === "unscheduled" && !blocked.has(entry.status.taskId) &&
                (!entry.task?.requires || entry.task.requires === "all-completed") &&
                entry.task?.dependencies?.some(id => failedDependencies.has(id) || blocked.has(id))) {
              blocked.add(entry.status.taskId);
              changed = true;
            }
          }
        } while (changed);
        for (const entry of tasks) {
          const status = entry.status;
          if (!["completed", "failed", "exception"].includes(status?.state) && !blocked.has(status?.taskId)) groupComplete = false;
          if (["failed", "exception"].includes(status?.state) && !allJobs.some(job => job.task_id === status.taskId)) {
            allJobs.push({ id: `task:${status.taskId}`, task_id: status.taskId,
              retry_id: status.runs?.at(-1)?.runId || 0, state: "completed", result: status.state,
              job_type_name: entry.task?.metadata?.name || "Unreported Taskcluster failure", platform: "unknown" });
          }
        }
      }
      // A retrigger is a distinct job. Keep every failure for the assessor.
      return { repo, revision, push, jobs: allJobs,
        complete: allJobs.length > 0 && groupComplete && allJobs.every(job => job.state === "completed" || blocked.has(job.task_id)),
        failures: allJobs.filter(job => job.state === "completed" && job.result !== "success") };

    },
    async compare(inspection, onProgress = () => {}) {
      const failures = [];
      for (const job of inspection.failures) failures.push(await evidence(inspection.repo, job));
      const candidates = [];
      for (const repo of ["comm-central", "try-comm-central", "try"]) {
        for (const push of await pushes(repo, { count: "50" })) {
          if (repo !== inspection.repo || push.id !== inspection.push?.id) candidates.push({ repo, push });
        }
      }
      const baseline = new Array(candidates.length);
      let next = 0, completed = 0, reused = 0;
      const activePushes = new Map();
      const progress = () => onProgress(completed, candidates.length, {
        reused, active: [...activePushes.values()],
      });
      progress();
      // Bound network work while keeping every push and failure in the result.
      const results = await Promise.allSettled(Array.from({ length: Math.min(6, candidates.length) }, async () => {
        while (next < candidates.length) {
          const index = next++;
          const { repo, push } = candidates[index];
          const checkpoint = path.join(evidenceDirectory, `push-${repo}-${push.id}.json`);
          let cached;
          try { cached = JSON.parse(await readFile(checkpoint, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (cached && cached.revision === push.revision) {
            baseline[index] = cached;
            completed++; reused++; progress();
            continue;
          }
          let allJobs;
          try { allJobs = await jobs(repo, push.id); }
          catch (error) {
            if (signal?.aborted) throw error;
            baseline[index] = { repo, revision: push.revision, jobs: [], failures: [], unavailableEvidence: [{ error: error.message }] };
            onProgress(++completed, candidates.length);
            continue;
          }
          const failed = [];
          const failedJobs = allJobs.filter(job => job.state === "completed" && job.result !== "success");
          const activity = { repo, push: push.id, done: 0, total: failedJobs.length };
          activePushes.set(index, activity);
          progress();
          for (const job of failedJobs) {
            try { failed.push(await evidence(repo, job)); }
            catch (error) {
              if (signal?.aborted) throw error;
              failed.push({ id: String(job.id), job: job.job_type_name, logs: [], unavailableEvidence: [{ error: error.message }] });
            }
            activity.done = failed.length;
            if (activity.done % 5 === 0 || activity.done === activity.total) progress();
          }
          baseline[index] = { repo, revision: push.revision, author: push.author || push.who,
            revisions: push.revisions, jobs: allJobs, failures: failed };
          // Completed runs are permanent snapshots, including unavailable logs.
          // Missing comparison evidence must not force another download scan.
          if (allJobs.length && allJobs.every(job => job.state === "completed")) {
            await mkdir(evidenceDirectory, { recursive: true });
            const temporary = `${checkpoint}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(baseline[index]), { mode: 0o600 });
            await rename(temporary, checkpoint);
          }
          activePushes.delete(index);
          completed++; progress();
        }
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      return { failures, baseline };
    },
    async findSubmission(marker, since) {
      // Search all pushes since this intent, including when the server was down.
      for (const repo of ["try-comm-central", "try"]) {
        let beforeId;
        for (let pageIndex = 0; ; pageIndex++) {
          const page = await pushes(repo, { count: "100", push_timestamp__gte: String(Math.floor(since / 1000)), ...(beforeId ? { id__lt: String(beforeId) } : {}) });
          const found = page.find(push => push.revisions?.some(revision => revision.comments?.includes(marker)));
          if (found) return `${TREEHERDER}/jobs?repo=${repo}&revision=${found.revision}`;
          if (page.length < 100) break;
          const oldestId = Math.min(...page.map(push => push.id));
          if (!Number.isFinite(oldestId) || oldestId === beforeId || pageIndex >= 1000) throw new Error("Submission recovery search is incomplete.");
          beforeId = oldestId;
        }
      }
      return "";
    },
  };
}
