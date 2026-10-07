import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createPhabricatorWebSession } from "../commands/graph/phab-auth.mjs";

test("dashboard browser discovery parses cards and follows pagination without external requests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-dashboard-browser-"));
  const visited = [];
  const session = createPhabricatorWebSession({
    profilePath: directory,
    browserLoader: async () => ({
      launchPersistentContext: async (profilePath) => {
        const context = await chromium.launchPersistentContext(profilePath, { headless: true });
        // Fulfil every request locally before creating or navigating any page.
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          visited.push(url);
          const mine = url.searchParams.has("authorPHIDs[]");
          const id = mine ? (url.searchParams.has("after") ? "D1001" : "D1000") : "D2000";
          const next = mine && !url.searchParams.has("after") ? `<a href="${url.pathname + url.search.replaceAll("&", "&amp;")}&amp;after=1000">Next</a>` : "";
          await route.fulfill({ contentType: "text/html", body: `<title>Query</title><script>globalThis.JX={Stratcom:{getData:node=>node?.dataset.status?{tip:node.dataset.status}:{}}};</script><ul class="phui-oi-list-view"><li class="phui-oi"><div class="phui-oi-status-icon" data-status="Needs Review"></div><a class="phui-oi-link" href="/${id}">Bug 123456 - A patch</a><div class="phui-oi-byline"><a href="/p/author/">author</a></div><ul class="phui-oi-attributes"><li><a class="phui-handle" href="/tag/team/">team</a></li></ul><span class="phui-oi-icon-label"><span class="print-only">2026-09-10 12:30:09 (UTC-4)</span></span></li></ul>${next}` });
        });
        return context;
      },
    }),
  });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await session.getDashboardRevisions({ currentUser: { phid: "PHID-USER-me" }, groups: [{ phid: "PHID-PROJ-team" }] });
  assert.deepEqual(result.mine.map((row) => row.id), ["D1000", "D1001"]);
  assert.equal(result.mine[0].statusName, "Needs Review");
  assert.equal(result.reviewQueue[0].authorName, "author");
  assert.deepEqual(result.reviewQueue[0].reviewers, [{ name: "team", type: "group" }]);
  const reviewSearch = visited.find((url) => url.searchParams.has("reviewerPHIDs[]"));
  assert.deepEqual(reviewSearch.searchParams.getAll("reviewerPHIDs[]"), ["PHID-USER-me", "PHID-PROJ-team"]);
  assert.equal(reviewSearch.searchParams.get("statuses[]"), "open()");
  assert.ok(visited.every((url) => !url.pathname.startsWith("/api/")));
});
