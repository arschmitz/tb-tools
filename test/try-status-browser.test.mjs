import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("Try badges show newest first after merging cached and fresh runs", async (t) => {
  const graphs = [];
  const server = await startInteractiveGraphServer({
    graphs,
    tryMonitor: null,
    token: "secret",
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "secret" }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(() => new Promise((resolve) => server.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  const result = await page.evaluate(async () => {
    const { renderCommitIntegrationStatus } = await import("/assets/graph-client/diff-viewer.js");
    const run = (id, createdAt) => ({ id, createdAt, url: `https://example.com/${id}` });
    const older = run("older", "2026-09-24T12:00:00Z");
    const latest = run("latest", "2026-09-25T12:00:00Z");
    const middle = run("middle", "2026-09-25T09:00:00Z");
    const unknown = run("unknown", "invalid");
    const cached = [older, unknown];
    const fresh = [latest, middle, older];
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    renderCommitIntegrationStatus(container, { tryRuns: cached }, {
      index: 0,
      commit: { hash: "abc123", tryRuns: fresh },
    });
    const history = container.querySelector(".try-run-history");
    const initiallyHidden = history.hidden;
    container.querySelector(".try-run-toggle").click();
    return {
      links: [...container.querySelectorAll("a.try")].map((link) => link.href),
      initiallyHidden,
      expanded: !history.hidden,
      cached: cached.map(({ id }) => id),
      fresh: fresh.map(({ id }) => id),
    };
  });
  assert.deepEqual(result.links, ["latest", "middle", "older", "unknown"].map((id) => `https://example.com/${id}`));
  assert.equal(result.initiallyHidden, true);
  assert.equal(result.expanded, true);
  assert.deepEqual(result.cached, ["older", "unknown"]);
  assert.deepEqual(result.fresh, ["latest", "middle", "older"]);
  const expansion = await page.evaluate(async () => {
    const { renderCommitIntegrationStatus } = await import("/assets/graph-client/diff-viewer.js");
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);
    const runs = [1, 2].map(id => ({ id, tbToolsId: "patch-one", url: `https://example.com/${id}`, createdAt: `2026-09-${id + 20}T00:00:00Z` }));
    const render = (hash, tryRuns = runs, subject = "Patch") => renderCommitIntegrationStatus(container, { tryRuns }, { index: 1, commit: { hash, subject } });
    render("old");
    container.querySelector(".try-run-toggle").click();
    // The loading state and replacement DOM must not discard expansion.
    container.textContent = "Loading...";
    render("new", [...runs, { ...runs[0], id: 3, url: "https://example.com/new", createdAt: "2026-09-29T00:00:00Z", status: "passed" }]);
    const afterRefresh = container.querySelector(".try-run-toggle").getAttribute("aria-expanded");
    const historyCount = container.querySelectorAll(".try-run-history a").length;
    render("fixup", runs, "fixup! Patch");
    const fixupHidden = container.querySelector(".try-run-history").hidden;
    render("new");
    const afterReturn = !container.querySelector(".try-run-history").hidden;
    container.querySelector(".try-run-toggle").click();
    render("new");
    return { afterRefresh, historyCount, fixupHidden, afterReturn, collapsed: container.querySelector(".try-run-history").hidden };
  });
  assert.deepEqual(expansion, { afterRefresh: "true", historyCount: 2, fixupHidden: true, afterReturn: true, collapsed: true });
  const labels = await page.evaluate(async () => {
    const { createTryRunStatus } = await import("/assets/graph-client/diff-viewer.js");
    return ["passed", "patch-failed", "submission-failed", "waiting", "analyzing", "repairing",
      "ready-to-submit", "submitting", "squashing", "needs-evidence", "stale", "superseded", "paused", undefined]
      .map(status => {
        const element = createTryRunStatus([{ url: "https://example.com/run", status }]);
        return element.querySelector(".status-value").textContent;
      });
  });
  assert.deepEqual(labels, [
    "Passed", "Failed", "Failed", "Pending", "Pending", "Pending", "Pending", "Pending", "Pending",
    "Pending", "Not Determined", "Not Determined", "Not Determined", "Not Determined",
  ]);
  const examples = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    return [
      { status: "patch-failed", phase: "repairing" },
      { status: "patch-failed", phase: "submitting" },
      { status: "patch-failed", rustFailure: {}, phase: "waiting-new-try" },
      { status: "patch-failed", failureCategory: "comm-central" },
      { status: "waiting" },
      { status: "analyzing" },
      { status: "passed" },
      { status: "passed", failureCategory: "comm-central" },
      { status: "passed", rustFailure: {} },
      { status: "unknown", imported: true },
    ].map(run => {
      const badge = createTryRunBadge(run, "Try");
      return [...badge.children].filter(child => !child.classList.contains("try-status-icon")).map(child => child.textContent).join(" ");
    });
  });
  assert.deepEqual(examples, [
    "Try Status: Failed - [Determining Fixes]",
    "Try Status: Failed - [Waiting for new run]",
    "Try Status: Failed - [Rust update needed]",
    "Try Status: Failed - [Comm-Central Broken]",
    "Try Status: Pending - [Waiting For Results]",
    "Try Status: Pending - [Analyzing Results]",
    "Try Status: Passed",
    "Try Status: Passed",
    "Try Status: Passed",
    "Try Status: Not Determined",
  ]);
  const managedHistory = await page.evaluate(async () => {
    const { getTryPillState } = await import("/assets/graph-client/commit-model.js");
    return [
      { monitorId: "managed", status: "failed-unclassified", phase: "superseded", statusComplete: true },
      { monitorId: "managed", status: "unknown", phase: "superseded" },
      { monitorId: "legacy", imported: true, status: "unknown" },
    ].map(run => getTryPillState(run).status);
  });
  assert.deepEqual(managedHistory, ["Pending", "Pending", "Not Determined"]);
  const retained = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    return ["passed", "waiting"].map(status => {
      const badge = createTryRunBadge({ status, error: "Temporary network error", stale: true }, "Try");
      return { text: badge.querySelector(".status-value").textContent, title: badge.title };
    });
  });
  assert.deepEqual(retained.map(item => item.text), ["Passed", "Pending"]);
  assert.ok(retained.every(item => /earlier version/.test(item.title)));
  const unclassified = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    const badge = createTryRunBadge({ status: "failed-unclassified", activity: "Evaluating" }, "Try");
    return { text: badge.textContent, title: badge.title };
  });
  assert.match(unclassified.text, /Pending.*Analyzing Results/);
  assert.match(unclassified.title, /not an AI patch verdict/);
  const blocked = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    const badge = createTryRunBadge({ status: "build-blocked", statusComplete: true }, "Try");
    return { text: badge.textContent, title: badge.title, red: badge.classList.contains("try-fail") };
  });
  assert.match(blocked.text, /Failed.*No successful build/);
  assert.match(blocked.title, /did not validate the patch/);
  assert.equal(blocked.red, true);
  const rust = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    const badge = createTryRunBadge({ status: "patch-failed", rustFailure: { signature: "Rust dependencies are out of sync" }, activity: "Waiting for Rust update" }, "Try");
    return { text: badge.textContent, red: badge.classList.contains("try-fail") };
  });
  assert.match(rust.text, /Failed.*Rust update needed/);
  assert.equal(rust.red, true);
  const progress = await page.evaluate(async () => {
    const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
    const { getCommitSnapshotFingerprint } = await import("/assets/graph-client/commit-model.js");
    const run = { status: "patch-failed", activity: "Working" };
    const before = getCommitSnapshotFingerprint({ hash: "fixup", tryRuns: [run] });
    run.activity = "Running tests";
    return {
      changed: before !== getCommitSnapshotFingerprint({ hash: "fixup", tryRuns: [run] }),
      labels: ["Evaluating", "Working", "Running tests", "Another Try posted"].map(activity =>
        createTryRunBadge({ ...run, activity }, "Try").querySelector(".try-activity").textContent),
    };
  });
  assert.equal(progress.changed, true);
  assert.deepEqual(progress.labels, ["- [Determining Fixes]", "- [Determining Fixes]", "- [Running tests]", "- [Determining Fixes]"]);
  for (const width of [320, 900]) {
    const layout = await page.evaluate(async width => {
      const { createTryRunStatus, createStatusBadge } = await import("/assets/graph-client/diff-viewer.js");
      const container = globalThis.document.createElement("div");
      container.className = "integration-status";
      container.style.width = width + "px";
      const runs = [1, 2, 3].map(id => ({ url: "https://example.com/" + id,
        status: "patch-failed", rustFailure: {}, createdAt: "2026-09-28T23:26:00Z" }));
      container.append(createTryRunStatus(runs), createStatusBadge({ label: "Bug 123", status: "Assigned", detail: "A long bug title ".repeat(20) }),
        createStatusBadge({ label: "D123", status: "Needs Revision", detail: "A review title ".repeat(20) }));
      globalThis.document.body.append(container);
      container.querySelector(".try-run-toggle").click();
      const bounds = container.getBoundingClientRect();
      const pills = [...container.querySelectorAll(".status-badge")].map(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const result = { pills, left: bounds.left, right: bounds.right, overflow: container.scrollWidth > container.clientWidth };
      container.remove();
      return result;
    }, width);
    assert.equal(layout.overflow, false, `No horizontal overflow at ${width}px`);
    for (let index = 0; index < layout.pills.length; index++) {
      const pill = layout.pills[index];
      assert.ok(Math.abs(pill.left - layout.left) < 1, "Pills share the same left edge");
      assert.ok(pill.right <= layout.right + 1, "Each pill fits within the pane");
      if (index) assert.ok(pill.top >= layout.pills[index - 1].bottom, "Each pill has its own row");
    }
  }
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const colors = await page.evaluate(async () => {
      const { createTryRunBadge } = await import("/assets/graph-client/diff-viewer.js");
      return ["passed", "patch-failed", "waiting", undefined].map(status => {
        const badge = createTryRunBadge({ url: "https://example.com/run", status }, "Try");
        globalThis.document.body.append(badge);
        const color = globalThis.getComputedStyle(badge).backgroundColor;
        badge.remove();
        return color;
      });
    });
    assert.equal(new Set(colors).size, 4, `Each Try result has a distinct color in ${colorScheme} mode`);
  }
});

test("fixup Pending Try status stays compact and Amend controls remain available", async t => {
  const parentHash = "a".repeat(40);
  const fixupHash = "b".repeat(40);
  const run = { id: "run", url: "https://treeherder.mozilla.org/jobs?repo=try&revision=" + "c".repeat(40),
    subject: "Feature Try run", createdAt: "2026-09-28T12:00:00Z", checkedAt: "2026-09-28T12:30:00Z", status: "waiting",
    monitorId: "monitor", summary: "No patch-caused failures.",
    assessment: { failures: [{ cause: "unrelated", reason: "Same assertion on comm-central.", evidence: ["baseline revision and exact error signature"] }] } };
  const author = { name: "Test", email: "test@example.com", timestamp: 1 };
  const graphs = [{ label: "comm", repository: "comm", checkout: "working", path: "/test/comm", branch: "patch",
    commits: [{ hash: fixupHash, parents: [parentHash], refs: [], author, subject: "fixup! Feature", tryFixup: { monitorId: "monitor", parent: parentHash }, tryRuns: [run] },
      { hash: parentHash, parents: [], refs: ["HEAD", "patch"], author, subject: "Feature", ownPatch: true, tryRuns: [run] }], diffs: {}, commitCount: 2 }];
  const info = await startInteractiveGraphServer({ graphs, token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "secret", pageSize: 80 }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/api/graph/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, message: "fixup! Feature", diff: "diff", tryRuns: [run] }) }));
  let amended = false;
  await page.route("**/api/amend-try-fixup", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.hash, fixupHash);
    assert.equal(body.token, "secret");
    amended = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, message: "Amended", snapshot: { ...graphs[0], commits: [graphs[0].commits[1]] } }) });
  });
  await page.goto(info.url);
  await page.evaluate(async () => {
    const { graphStates, uiState } = await import("/assets/graph-client/config.js");
    const { renderLaneGraph } = await import("/assets/graph-client/lane-renderer.js");
    const { showDiff } = await import("/assets/graph-client/commit-actions.js");
    uiState.loadObserver = new globalThis.IntersectionObserver(() => {});
    graphStates[0].commits = graphStates[0].graph.commits;
    renderLaneGraph(0, graphStates[0].commits);
    await showDiff(graphStates[0].graph, 0, graphStates[0].commits[0], { loadIntegration: true });
  });
  assert.equal(await page.locator(".commit-row.working-tree .commit-message").textContent(), "fixup! Feature");
  const amend = page.locator("#diff-0 .amend-commit");
  assert.equal(await amend.textContent(), "Amend");
  assert.match(await page.locator("#diff-0 .try-run-current").textContent(), /Try Status:.*Pending/);
  assert.equal(await page.locator(".try-monitor-details").count(), 0);
  assert.match(await page.locator("#diff-0 .try-run-current .try").getAttribute("title"), /Feature Try run/);
  assert.equal(await page.locator("#diff-0 .try-run-current .status-value").textContent(), "Pending");
  assert.equal(await page.locator("#diff-0 .try-pending").count(), 1);
  assert.doesNotMatch(await page.locator("#diff-0 .try-run-group").textContent(), /Same assertion|No patch-caused/);
  const changes = await page.evaluate(async () => {
    const { getCommitSnapshotFingerprint } = await import("/assets/graph-client/commit-model.js");
    const { graphStates } = await import("/assets/graph-client/config.js");
    const commit = graphStates[0].commits[0];
    const before = getCommitSnapshotFingerprint(commit);
    commit.tryRuns[0].status = "repairing";
    return before !== getCommitSnapshotFingerprint(commit);
  });
  assert.equal(changes, true);
  await page.evaluate(async () => {
    const { renderCommitIntegrationStatus } = await import("/assets/graph-client/diff-viewer.js");
    const { graphStates } = await import("/assets/graph-client/config.js");
    const commit = graphStates[0].commits[0];
    commit.tryRuns[0].status = "patch-failed";
    commit.tryRuns[0].activity = "Running tests";
    renderCommitIntegrationStatus(globalThis.document.querySelector("#diff-0 .integration-status"), {}, { index: 0, commit });
  });
  assert.equal(await page.locator("#diff-0 .integration-status .try").count(), 1);
  assert.equal(await page.locator("#diff-0 .try-run-current .status-value").textContent(), "Failed");
  assert.match(await page.locator("#diff-0 .try-run-current .try-activity").textContent(), /Running tests/);
  assert.deepEqual(await page.locator("#diff-0 .try-run-current .try").evaluate(badge => [...badge.children].slice(0, 3).map(child => child.textContent)), ["✕", "Try Status:", "Failed"]);
  assert.equal(await page.locator("#diff-0 .try-status-icon").getAttribute("aria-hidden"), "true");
  assert.equal(await page.locator(".commit-row.working-tree .commit-message").textContent(), "fixup! Feature");
  await page.evaluate(async () => {
    const { openAmendDialog } = await import("/assets/graph-client/commit-actions.js");
    await openAmendDialog(globalThis.document.querySelector("#diff-0 .amend-commit"));
  });
  assert.equal(amended, true);
  assert.equal(await page.locator(".commit-row.working-tree").count(), 0);
});
