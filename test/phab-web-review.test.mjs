import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPhabricatorWebSession } from "../commands/graph/phab-auth.mjs";
import { markWebInlineDone, publishWebReview, readWebReview, saveWebInline } from "../commands/graph/phab-web-review.mjs";
import { getGraphCommitReview } from "../commands/graph/reviews.mjs";

const fixture = `<!doctype html><title>D123</title>
<a href="/D123?download=true">Download Raw Diff</a>
<div data-sigil="differential-changeset" data-fixture='{"right":"100","symbolPath":"mail/example.mjs"}'>
<div data-sigil="differential-inline-comment" data-fixture='{"id":"22","phid":"PHID-XCMT-new","changesetID":"100","number":"7","length":"0","isNewFile":true,"state":{"committed":{"text":"Remove this line.","hasSuggestion":true,"suggestionText":""}}}'><span class="inline-head-left">Reviewer</span></div>
<div data-sigil="differential-inline-comment" data-fixture='{"id":"23","phid":"PHID-XCMT-old","changesetID":"100","number":"7","length":"2","isNewFile":false,"state":{"committed":{"text":"Old context","hasSuggestion":false}}}'></div></div>
<div class="phui-timeline-event-view" id="comment-30"><div class="phui-timeline-title"><a class="phui-handle">Reviewer</a></div><div class="phui-timeline-content"><div class="phabricator-remarkup">Overall feedback</div></div></div>
<form data-sigil="transaction-append" action="/publish" method="post">
<input name="__csrf__" value="fixture"><input name="editengine.actions">
<select><option value="+">Add Action</option><option value="accept">Accept</option><option value="reject">Request Changes</option></select>
<textarea name="comment"></textarea><button data-sigil="submit-transactions">Submit</button></form>
<script>
window.JX = {Stratcom:{getData:n=>JSON.parse(n.dataset.fixture)},DiffChangeset:{getForNode:()=>({load(){}})}};
document.querySelector('select').onchange = e => {e.target.selectedOptions[0].disabled=true;document.querySelector('[name="editengine.actions"]').value=JSON.stringify([{type:e.target.value,value:true}]);};
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const action=JSON.parse(document.querySelector('[name="editengine.actions"]').value||'[]')[0]?.type||'comment';const r=await fetch('/publish',{method:'POST',body:new FormData(e.target)});if(r.ok){const entry=document.createElement('div');entry.className='phui-timeline-event-view';const title=action==='accept'?'accepted this revision.':action==='reject'?'requested changes to this revision.':'added a comment.';entry.innerHTML='<a class="phabricator-anchor-view" id="11280584" name="11280584"></a><div class="phui-timeline-title">Reviewer '+title+'</div>';document.body.append(entry);document.querySelector('textarea').value='';document.querySelectorAll('.phui-comment-action').forEach(e=>e.remove());const selected=document.querySelector('select');selected.value='+';if(action!=='comment')selected.querySelector('option[value="'+action+'"]').remove();}};
</script>`;

async function installFixtureRoutes(context, requests, badSave = false, rawAttachment = true) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    requests.push(request);
    if (request.method() === "POST" && request.url().includes("/inline/edit/")) {
      const response = new Response(request.postDataBuffer(), { headers: { "Content-Type": request.headers()["content-type"] } });
      const data = await response.formData();
      requests[requests.length - 1] = Object.fromEntries(data);
      if (data.get("op") === "done") {
        await route.fulfill({ contentType: "application/json", body: `for (;;);${JSON.stringify({ payload: { isChecked: !badSave, draftState: true } })}` });
        return;
      }
      const state = { text: badSave ? "wrong" : data.get("text"), hasSuggestion: data.get("hasSuggestion") === "1", suggestionText: data.get("suggestionText") };
      await route.fulfill({ contentType: "application/json", body: `for (;;);${JSON.stringify({ payload: { inline: { id: 99, state: { committed: state } } } })}` });
    } else if (!rawAttachment && new URL(request.url()).searchParams.get("download") === "true") {
      // Use a new navigation: Playwright does not route each hop of an HTTP redirect.
      await route.fulfill({ contentType: "text/html", body: "<script>location.href='https://files.example/file.diff'</script>" });
    } else if (new URL(request.url()).searchParams.get("download") === "true" || new URL(request.url()).pathname === "/file.diff") {
      await route.fulfill({ contentType: "text/plain", headers: rawAttachment ? { "Content-Disposition": "attachment; filename=patch.diff" } : {}, body: "diff --git a/mail/example.mjs b/mail/example.mjs\n--- a/mail/example.mjs\n+++ b/mail/example.mjs\n@@ -7 +7 @@\n-old\n+new\n" });
    } else if (request.method() === "POST") {
      await route.fulfill({ body: "ok" });
    } else {
      await route.fulfill({ contentType: "text/html", body: fixture });
    }
  });
}

async function browserFixture(t, { badSave = false } = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const requests = [];
  await installFixtureRoutes(context, requests, badSave);
  const page = await context.newPage();
  await page.goto("https://phabricator.example/D123");
  return { page, requests };
}

for (const rawAttachment of [true, false]) {
test(`authenticated web session reads, saves drafts, and publishes with ${rawAttachment ? "download" : "redirected plain text"} raw patch`, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-web-review-test-"));
  const requests = [];
  const session = createPhabricatorWebSession({
    profilePath: directory,
    browserLoader: async () => ({
      launchPersistentContext: async (profilePath) => {
        const context = await chromium.launchPersistentContext(profilePath, { headless: true });
        await installFixtureRoutes(context, requests, false, rawAttachment);
        return context;
      },
    }),
  });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  const [first, second] = await Promise.all([session.getReview({ revision: "D123" }), session.getReview({ revision: "D123" })]).catch((error) => {
    t.diagnostic(JSON.stringify(requests.map((request) => typeof request.url === "function" ? request.url() : request)));
    throw error;
  });
  assert.deepEqual(first, second);
  assert.match(first.rawPatch, /diff --git/);
  assert.match(first.inlineComments[0].contextDiff, /diff --git/);
  assert.equal(requests.filter((r) => typeof r.url === "function" && new URL(r.url()).searchParams.has("download")).length, 1);
  assert.equal((await session.postInlineReply({ revision: "D123", commentPHID: "PHID-XCMT-new", message: "Fixed." })).inlineId, 99);
  assert.deepEqual(await session.markInlineCommentDone({ revision: "D123", commentPHID: "PHID-XCMT-new" }), { revision: "D123", parentCommentPHID: "PHID-XCMT-new" });
  await assert.rejects(async () => session.postInlineReply({ revision: "D123", commentPHID: "bad", message: "Do not post." }), /detached reply/);
  await session.publishRevisionReview({ revision: "D123", action: "reject", message: "Please fix this." });
  assert.ok(requests.every((r) => typeof r.url !== "function" || !new URL(r.url()).pathname.startsWith("/api/")));
});
}

test("web review keeps full native deletion suggestions and both source-side coordinates", async (t) => {
  const { page } = await browserFixture(t);
  const result = await readWebReview(page, "D123");
  assert.equal(result.comments[0].content, "Overall feedback");
  assert.deepEqual(result.inlineComments[0].codeSuggestion, { content: "", isDeletion: true });
  assert.equal(result.inlineComments[0].lineNumber, 7);
  assert.equal(result.inlineComments[0].contextLineSide, "new");
  assert.equal(result.inlineComments[1].contextLineSide, "old");
  assert.equal(result.inlineComments[1].lineLength, 3);
});

test("web inline saves a native suggestion and prose on the new side, without publishing", async (t) => {
  const { page, requests } = await browserFixture(t);
  const result = await saveWebInline(page, { revision: "D123", filePath: "mail/example.mjs", lineNumber: 7,
    content: "Please fix this.", hasSuggestion: true, suggestionText: "  fixed();\n" });
  assert.equal(result.inlineId, 99);
  const posts = requests.filter((entry) => entry.op);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((entry) => entry.op), ["new", "save"]);
  for (const post of posts) {
    assert.equal(post.number, "7");
    assert.equal(post.length, "0");
    assert.equal(post.changesetID, "100");
    assert.equal(post.is_new, "1");
    assert.equal(post.on_right, "1");
    assert.equal(post.suggestionText.replace(/\r\n/g, "\n"), "  fixed();\n");
    assert.equal(post.text, "Please fix this.");
  }
  await saveWebInline(page, { revision: "D123", filePath: "mail/example.mjs", lineNumber: 7,
    content: "Delete this line.", hasSuggestion: true, suggestionText: "" });
  const deletion = requests.filter((entry) => entry.op === "save").at(-1);
  assert.equal(deletion.hasSuggestion, "1");
  assert.equal(deletion.suggestionText, "");
});

test("web replies keep the parent and reject old-side anchors before posting", async (t) => {
  const { page, requests } = await browserFixture(t);
  await assert.rejects(saveWebInline(page, { revision: "D123", commentPHID: "PHID-XCMT-old", content: "reply" }), /new\/right side/);
  assert.equal(requests.filter((entry) => entry.op).length, 0);
  await saveWebInline(page, { revision: "D123", commentPHID: "PHID-XCMT-new", content: "reply" });
  assert.equal(requests.find((entry) => entry.op === "reply").replyToCommentPHID, "PHID-XCMT-new");
});

test("web save rejects a response that did not store the requested text", async (t) => {
  const { page } = await browserFixture(t, { badSave: true });
  await assert.rejects(saveWebInline(page, { revision: "D123", filePath: "mail/example.mjs", lineNumber: 7, content: "reply" }), /did not confirm/);
});

test("web Done uses the exact inline ID and requires the saved-state response", async (t) => {
  const { page, requests } = await browserFixture(t);
  assert.deepEqual(await markWebInlineDone(page, { revision: "D123", commentPHID: "PHID-XCMT-new" }), { checked: true });
  assert.equal(requests.find((entry) => entry.op === "done").id, "22");
  const failed = await browserFixture(t, { badSave: true });
  await assert.rejects(markWebInlineDone(failed.page, { revision: "D123", commentPHID: "PHID-XCMT-new" }), /did not confirm/);
});

for (const action of ["accept", "reject", "comment"]) {
  test(`web publication confirms ${action} when Phabricator removes the submitted action`, async (t) => {
    const { page, requests } = await browserFixture(t);
    await publishWebReview(page, { action, message: "Reviewed." });
    const post = requests.find((entry) => typeof entry.url === "function" && entry.url().endsWith("/publish"));
    assert.ok(post);
    const data = await new Response(post.postDataBuffer(), { headers: { "Content-Type": post.headers()["content-type"] } }).formData();
    assert.equal(data.get("comment"), "Reviewed.");
    if (action !== "comment") {
      assert.equal(JSON.parse(data.get("editengine.actions"))[0].type, action);
    }
  });
}

test("web publication resumes the same pending action after a pre-submit failure", async (t) => {
  const { page, requests } = await browserFixture(t);
  await page.locator("select").selectOption("reject");
  await page.evaluate(() => {
    const document = globalThis.document;
    const action = document.createElement("div");
    action.className = "phui-comment-action";
    action.textContent = "Request Changes";
    document.querySelector("form").append(action);
  });
  await assert.rejects(publishWebReview(page, { action: "accept", message: "Wrong action" }), /saved review action/);
  assert.equal(requests.filter((r) => typeof r.method === "function" && r.method() === "POST").length, 0);
  await publishWebReview(page, { action: "reject", message: "Please fix this." });
  assert.equal(requests.filter((r) => typeof r.method === "function" && r.method() === "POST").length, 1);
});

test("graph discussion uses the web reader without any Conduit calls", async () => {
  let webCalls = 0;
  const result = await getGraphCommitReview({
    graph: { path: "/fixture" }, hash: "abc",
    runCommand: async () => "Bug 1\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123",
    phab: async () => assert.fail("Conduit must not be called"),
    getWebReview: async ({ revision }) => { webCalls++; return { revision, comments: [{ content: "web" }], inlineComments: [] }; },
  });
  assert.equal(webCalls, 1);
  assert.equal(result.comments[0].content, "web");
});

test("web publication keeps an existing overall draft with the final review text", async (t) => {
  const { page, requests } = await browserFixture(t);
  await page.locator("textarea[name='comment']").fill("Existing saved note.");
  await publishWebReview(page, { action: "comment", message: "Final note." });
  const post = requests.find((entry) => typeof entry.url === "function" && entry.url().endsWith("/publish"));
  const data = await new Response(post.postDataBuffer(), { headers: { "Content-Type": post.headers()["content-type"] } }).formData();
  assert.equal(data.get("comment").replace(/\r\n/g, "\n"), "Existing saved note.\n\nFinal note.");
});

for (const saved of [false, true]) {
  for (const personal of [false, true]) {
    test(`accept only as yourself with saved=${saved} and personal option=${personal}`, async t => {
      const { page, requests } = await browserFixture(t);
      await page.evaluate(personal => {
        const document = globalThis.document;
        const select = document.querySelector("select");
        const originalChange = select.onchange;
        select.onchange = event => {
          originalChange(event);
          const action = document.createElement("div");
          action.className = "phui-comment-action";
          const options = [
            ...(personal ? [["PHID-USER-me", "Accept as Myself"]] : []),
            ["PHID-PROJ-team", "Accept as Team"],
            ["PHID-OPKG-package", "Accept as Package"],
            ["PHID-USER-other", "Force accept as Other"],
          ];
          for (const [value, text] of options) {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = value;
            input.id = value;
            input.checked = value !== "PHID-USER-me";
            const label = document.createElement("label");
            label.htmlFor = value;
            label.textContent = text;
            action.append(input, label);
          }
          document.querySelector("form").append(action);
        };
        document.querySelector("form").addEventListener("submit", () => {
          document.querySelector('[name="editengine.actions"]').value = JSON.stringify([{
            type: "accept", value: [...document.querySelectorAll('.phui-comment-action input:checked')].map(node => node.value),
          }]);
        }, true);
      }, personal);
      if (saved) await page.locator("select").selectOption("accept");
      if (!personal) {
        await assert.rejects(publishWebReview(page, { action: "accept", message: "Reviewed." }), /personal acceptance option/);
        assert.equal(requests.filter(entry => typeof entry.method === "function" && entry.method() === "POST").length, 0);
        return;
      }
      await publishWebReview(page, { action: "accept", message: "Reviewed." });
      const post = requests.find(entry => typeof entry.url === "function" && entry.url().endsWith("/publish"));
      const data = await new Response(post.postDataBuffer(), { headers: { "Content-Type": post.headers()["content-type"] } }).formData();
      assert.deepEqual(JSON.parse(data.get("editengine.actions")), [{ type: "accept", value: ["PHID-USER-me"] }]);
    });
  }
}
