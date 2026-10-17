import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("scheduled knowledge checks appear in Background jobs without running commands", async t => {
  const graphs = [{ label: "comm", path: "/test/comm", commits: [] }];
  const knowledge = { enabled: true, running: false, pending: 3,
    nextAt: "2026-10-13T18:00:00Z", checks: [],
    latest: { state: "confirmed", explanation: "The caller contract is missing.", at: "2026-10-13T12:00:00Z" },
    work: [{ question: "What cancels this operation?", explanation: "The caller contract is missing.", repository: "thunderbird", paths: ["mail/cancel.js"] }] };
  const server = await startInteractiveGraphServer({ graphs, token: "test", tryMonitor: null,
    runCommand: async () => assert.fail("Viewing knowledge status should not run commands."),
    getKnowledgeService: async () => ({ queryGapStatus: () => knowledge }),
    backgroundTryStore: { list: () => [], isAutomationPaused: () => false },
    appConfig: { ai: { enabled: true } },
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "test", aiEnabled: true }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  assert.equal((await fetch(new URL("/api/background-jobs?token=wrong", server.url))).status, 403, "Knowledge job status should require authentication.");
  const response = await (await fetch(new URL("/api/background-jobs?token=test", server.url))).json();
  assert.equal(response.jobs[0].phase, "scheduled", "An idle checker should show its scheduled state.");
  assert.equal(response.jobs[0].aiRunning, false, "An idle schedule should not claim an AI process is running.");
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/background-jobs.js")).initializeBackgroundJobs());
  await page.evaluate(() => { globalThis.document.querySelector(".graph-options-menu").hidden = false; });
  await page.getByRole("menuitem", { name: "Background jobs", exact: true }).click();
  await page.getByRole("heading", { name: "Knowledge gap checks", exact: true }).waitFor();
  assert.match(await page.locator(".background-job").textContent(), /3 queries awaiting checks/, "The monitor should show pending checks.");
  await page.getByText("Confirmed knowledge gaps", { exact: true }).click();
  await page.getByRole("heading", { name: "What cancels this operation?", exact: true }).waitFor();
  assert.match(await page.locator(".background-job details").textContent(), /checked evaluation is required/, "The monitor should retain the evaluation requirement.");
  knowledge.running = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelector(".jobs-state").textContent.includes("AI running"));
  assert.match(await page.locator(".jobs-state").textContent(), /checking.*AI running/, "An active check should show actual running state.");
});

test("automatic answer review appears in the console and open results survive refresh", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { openKnowledgeStore } = await import("../commands/knowledge/store.mjs");
  const { captureQueryObservation, captureQueryOutcome, reviewQueryGap, queryGapWork } = await import("../commands/knowledge/query-gaps.mjs");
  const { initializeGapEvaluations, runQueryGapEvaluations, gapEvaluationStatus, reviewGapAnswer } = await import("../commands/knowledge/query-gap-evaluation.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "gap-monitor-review-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const revision = "a".repeat(40), quote = "function cancelOperation() { controller.abort(); }";
  const source = await store.put({ kind: "evidence", repository: "thunderbird", paths: ["mail/cancel.js"], text: quote,
    at: "2026-10-13T10:00:00Z", source: { type: "code-snapshot", revision, file: "mail/cancel.js", verified: true } });
  const id = captureQueryObservation(store, { repository: "thunderbird", root: "/test/comm", revision,
    question: "What cancels this operation?", query: "cancelOperation" });
  captureQueryOutcome(store, id, { status: "completed", evidenceId: source.id });
  const review = reviewQueryGap(store, { observationId: id, state: "confirmed", reason: "answer-misuse", evidenceIds: [source.id],
    checkedBy: "Source reviewer", explanation: "The answer missed cancellation.", verification: "Checked the cancellation function." });
  initializeGapEvaluations(store);
  const work = { ...queryGapWork(store, review.key), sourceChecks: [{ path: "mail/cancel.js", revision, quote }] };
  store.db.prepare("INSERT INTO query_gap_work VALUES (?, ?, ?)").run(review.key, "2026-10-13T10:00:00Z", JSON.stringify(work));
  await runQueryGapEvaluations(store, {}, { git: async (_root, args) => args[0] === "show" ? quote : args[0] === "diff" ? "" : args[1] === "HEAD" ? revision : "blob",
    now: () => Date.parse("2026-10-13T11:00:00Z"), maxCallsPerDay: 1,
    provider: { generate: async () => `cancelOperation calls controller.abort(). Source: ${source.id}` } });
  const graphs = [{ label: "comm", path: "/test/comm", commits: [] }];
  let pending = 0;
  const server = await startInteractiveGraphServer({ graphs, token: "review-token", tryMonitor: null,
    runCommand: async () => assert.fail("Reviewing an answer should not run shell commands."),
    getKnowledgeService: async () => ({
      queryGapStatus: () => ({ enabled: true, pending, work: [], checks: [], evaluations: gapEvaluationStatus(store) }),
      reviewGapAnswer: (key, input) => reviewGapAnswer(store, key, input),
    }),
    backgroundTryStore: { list: () => [], isAutomationPaused: () => false }, appConfig: { ai: { enabled: true } },
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "review-token", aiEnabled: true }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const bad = await fetch(new URL("/api/knowledge/gap-answer-review", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong", key: work.key }) });
  assert.equal(bad.status, 403, "Saving a review should require the current console token.");
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/background-jobs.js")).initializeBackgroundJobs());
  await page.evaluate(() => { globalThis.document.querySelector(".graph-options-menu").hidden = false; });
  await page.getByRole("menuitem", { name: "Background jobs", exact: true }).click();
  await page.getByText("Answer evaluation: What cancels this operation?", { exact: true }).click();
  assert.match(await page.locator(".knowledge-gap-evaluations").textContent(), /Automatic source review waits/, "An exhausted budget should explain the pending automatic review.");
  assert.equal(await page.getByRole("button", { name: "Save answer review", exact: true }).count(), 0, "Answer evaluation should require no human review form.");
  pending = 1;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelector(".background-job").textContent.includes("1 queries awaiting checks"));
  assert.equal(await page.locator(".knowledge-gap-evaluations details").evaluate(node => node.open), true, "A status refresh should preserve the open evaluation result.");
  await runQueryGapEvaluations(store, {}, {
    git: async (_root, args) => args[0] === "show" ? quote : args[0] === "diff" ? "" : args[1] === "HEAD" ? revision : "blob",
    now: () => Date.parse("2026-10-14T11:00:00Z"), maxCallsPerDay: 1,
    provider: { configuration: { provider: "synthetic-test", model: "stub" }, generate: async () => JSON.stringify({
      rationale: "The saved answer matches the cancellation source.",
      scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 },
      facts: [{ index: 0, verdict: "supported", reason: "The source calls abort and the answer identifies that call." }],
      prohibitedClaims: [{ index: 0, verdict: "absent", reason: "The answer claims no runtime test." }, { index: 1, verdict: "absent", reason: "The answer states the source behavior without a broader proof claim." }],
      sourceChecks: [{ sourceIndex: 0, quote, reason: "The function calls controller.abort()." }],
    }) },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelector(".knowledge-gap-evaluations").textContent.includes("assistant-reviewed-pass"));
  assert.equal(await page.getByRole("heading", { name: "Source review", exact: true }).count(), 1, "The console should show the completed automatic source review.");
  assert.equal(await page.locator(".knowledge-gap-evaluations dd").count(), 5, "The source review should show all five quality scores.");
  assert.equal(gapEvaluationStatus(store).reports[0].answerReview.reviewerKind, "assistant", "The saved review should identify the assistant as reviewer.");
});

test("knowledge initialization never delays the background job status endpoint", async t => {
  const graphs = [{ label: "comm", path: "/test/comm", commits: [] }];
  const server = await startInteractiveGraphServer({ graphs, token: "loading-token", tryMonitor: null,
    getKnowledgeService: () => new Promise(() => {}),
    getKnowledgeStatus: () => ({ enabled: true, initializing: true, running: false, pending: 0, work: [], checks: [] }),
    backgroundTryStore: { list: () => [], isAutomationPaused: () => false }, appConfig: { ai: { enabled: true } },
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const response = await fetch(new URL("/api/background-jobs?token=loading-token", server.url), { signal: AbortSignal.timeout(1000) });
  const data = await response.json();
  assert.equal(response.status, 200, "Saved job status should remain available during knowledge initialization.");
  assert.equal(data.jobs[0].phase, "loading", "The knowledge job should explain its loading state.");
  assert.equal(data.jobs[0].aiRunning, false, "Index loading should not claim an AI process is running.");
});
