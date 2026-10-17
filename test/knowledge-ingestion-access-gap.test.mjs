import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../commands/knowledge/store.mjs";
import {
  INGESTION_ACCESS_GAP_STATUS,
  validateIngestionAccessGap,
  projectIngestionAccessGap,
} from "../commands/knowledge/ingestion-access-gap.mjs";

function fixture(index = 654) {
  const records = new Map();
  const bugs = [], reviews = [];
  for (const surface of ["bugzilla", "phabricator"]) {
    const url = surface === "bugzilla"
      ? "https://bugzilla.mozilla.org/show_bug.cgi?id=1912723"
      : "https://phabricator.services.mozilla.com/D219038";
    const readScope = surface === "bugzilla"
      ? { blocked: "access-denied", completeVisibleTimeline: false, appliesToIndices: [index] }
      : { accessDenied: true, contentRead: false, completeAvailableContext: false,
        completeHumanTimeline: false, completeSubmittedInlineThreads: false };
    const page = { url, indices: [index], title: surface === "bugzilla" ? "Access Denied"
      : "Access Denied: Restricted Differential Revision",
    body: surface === "bugzilla" ? "Access Denied\nYou are not authorized to access bug 1912723."
      : "Access Denied: Restricted Differential Revision\nYou do not have permission to view this object." };
    const body = { version: 1, kind: "evidence", visibility: "private", repository: "thunderbird",
      at: "2026-10-13T17:00:00Z", paths: [], source: { type: "browser-discussion", public: false, url, readScope },
      text: JSON.stringify(page) };
    const record = { ...body, id: digest(body) };
    records.set(record.id, record);
    const context = { url, status: "access-denied", contentRead: false,
      completeAvailableContext: false, evidence: [record.id], note: "Private note must not be shared." };
    (surface === "bugzilla" ? bugs : reviews).push(context);
  }
  const row = { index, hash: "a".repeat(40), status: INGESTION_ACCESS_GAP_STATUS,
    reason: "Both assigned pages deny access.", paths: ["mail/example.js"], bugs, reviews,
    fullHistoricalDiffRead: true, fullEligibleOwnedDiffRead: true };
  return { row, records, get: id => records.get(id) };
}

function changeProof(f, context, update) {
  const old = f.records.get(context.evidence[0]);
  const { id, ...body } = structuredClone(old);
  update(body);
  const record = { ...body, id: digest(body) };
  f.records.delete(id);
  f.records.set(record.id, record);
  context.evidence = [record.id];
}

test("explicit denials support either surface and arbitrary assigned indices", () => {
  for (const index of [615, 616, 617, 654, 999]) {
    const f = fixture(index);
    assert.equal(validateIngestionAccessGap(f.row, f.get).contexts.length, 2,
      "Both saved denied contexts should validate without an index whitelist.");
    for (const key of ["bugs", "reviews"]) {
      const row = { ...f.row, [key]: [] };
      assert.equal(validateIngestionAccessGap(row, f.get).contexts.length, 1,
        "A row with one assigned denied surface should validate its own proof.");
    }
  }
});

test("every denied context requires its own exact private proof", () => {
  for (const update of [
    f => { f.row.reviews[0].evidence = []; },
    f => { f.row.reviews[0].evidence = ["f".repeat(64)]; },
    f => { f.row.reviews[0].evidence = [...f.row.bugs[0].evidence]; },
    f => { f.row.bugs[0].contentRead = true; },
    f => { f.row.reviews[0].completeAvailableContext = true; },
    f => { f.row.bugs[0].contentRead = undefined; },
  ]) {
    const f = fixture();
    update(f);
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A missing, mismatched or read denial context should reject the whole row.");
  }
});

test("proof scope, private classification and immutable checksums remain required", () => {
  for (const update of [
    body => { body.visibility = "shared"; },
    body => { body.repository = "tb-tools"; },
    body => { body.source.type = "agent-turn"; },
    body => { body.source.public = true; },
    body => { body.source.url = "https://bugzilla.mozilla.org/show_bug.cgi?id=1"; },
    body => { body.source.readScope.appliesToIndices = [1]; },
    body => { body.source.readScope.mainContentRead = true; },
    body => { const page = JSON.parse(body.text); page.url += "#c0"; body.text = JSON.stringify(page); },
  ]) {
    const f = fixture();
    changeProof(f, f.row.bugs[0], update);
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A proof with changed visibility, repository, URL or read scope should reject.");
  }
  const f = fixture();
  f.records.get(f.row.bugs[0].evidence[0]).text += "changed";
  assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
    "A changed immutable capture body should reject its saved ID.");
});

test("pending contexts and unrelated errors never become terminal denied audits", () => {
  for (const status of ["pending", "examined", "loading", "blocked-browser-ui"]) {
    const f = fixture();
    f.row.status = status;
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A nonterminal or ordinary examined row should not become an access gap.");
  }
  for (const title of ["A human discussion quotes Access Denied", "429 Too Many Requests", "Sign in", "Loading"]) {
    const f = fixture();
    changeProof(f, f.row.bugs[0], body => {
      const page = JSON.parse(body.text); page.title = title; body.text = JSON.stringify(page);
    });
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A normal page or temporary error should not prove browser access denial.");
  }
  const f = fixture();
  f.row.reviews[0] = { url: f.row.reviews[0].url, status: "pending-unread" };
  assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
    "Another unread assigned context should keep a denied row incomplete.");
});

test("each service requires its explicit saved denial contract", () => {
  for (const [key, update] of [
    ["bugs", body => { body.source.readScope.blocked = "blocked-browser-ui"; }],
    ["bugs", body => { const page = JSON.parse(body.text); page.body = "Access Denied for another bug."; body.text = JSON.stringify(page); }],
    ["reviews", body => { body.source.readScope.accessDenied = false; }],
    ["reviews", body => { body.source.readScope.completeHumanTimeline = true; }],
    ["reviews", body => { body.source.readScope.completeSubmittedInlineThreads = true; }],
    ["reviews", body => { const page = JSON.parse(body.text); page.body = "An unrelated page."; body.text = JSON.stringify(page); }],
  ]) {
    const f = fixture();
    changeProof(f, f.row[key][0], update);
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A service-specific denial should require its exact error and incomplete read flags.");
  }
});

test("all projected contexts require canonical service URLs and known completed statuses", () => {
  for (const [key, context] of [
    ["bugs", { url: "synthetic-private-note", status: "synthetic-private-prose" }],
    ["bugs", { url: "https://bugzilla.mozilla.org/show_bug.cgi?id=1", status: "synthetic-private-prose" }],
    ["reviews", { url: "https://phabricator.services.mozilla.com/D1#private", status: "restricted-readable-private" }],
    ["bugs", { url: "https://phabricator.services.mozilla.com/D1", status: "read-complete-retained-context" }],
  ]) {
    const f = fixture();
    f.row[key].push(context);
    assert.throws(() => projectIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "An unknown status or noncanonical service URL should reject before public projection.");
  }
  for (const status of ["read-complete-visible-retained-context", "read-complete-retained-context", "restricted-readable-private"]) {
    const f = fixture();
    f.row.reviews.push({ url: "https://phabricator.services.mozilla.com/D217997", status });
    assert.equal(projectIngestionAccessGap(f.row, f.get).reviews[1].status, status,
      "A known completed context should preserve its exact status in public metadata.");
  }
});

test("saved page scopes cannot contradict an unread denial capture", () => {
  for (const [key, savedScope] of [
    ["reviews", { contentRead: true }],
    ["reviews", { completeHumanTimeline: true }],
    ["reviews", { accessDenied: false }],
    ["bugs", { mainContentRead: true }],
    ["bugs", { completeVisibleTimeline: true }],
    ["bugs", { blocked: "blocked-browser-ui" }],
    ["bugs", { appliesToIndices: [1] }],
  ]) {
    const f = fixture();
    changeProof(f, f.row[key][0], body => {
      const page = JSON.parse(body.text); page.readScope = savedScope; body.text = JSON.stringify(page);
    });
    assert.throws(() => validateIngestionAccessGap(f.row, f.get), /Unverified access gap/,
      "A checksum-valid page with conflicting saved scope should reject the denial.");
  }
  const f = fixture();
  for (const key of ["bugs", "reviews"]) {
    changeProof(f, f.row[key][0], body => {
      const page = JSON.parse(body.text); page.readScope = { ...body.source.readScope }; body.text = JSON.stringify(page);
    });
  }
  assert.equal(validateIngestionAccessGap(f.row, f.get).contexts.length, 2,
    "Matching supplied saved scopes should preserve valid denial captures.");
  const legacy = fixture();
  assert.equal(validateIngestionAccessGap(legacy.row, legacy.get).contexts.length, 2,
    "Legacy captures without saved page scopes should remain valid.");
});

test("the public gap projection omits private identifiers and raw prose", () => {
  const f = fixture();
  const before = structuredClone(f.row);
  f.row.observations = ["Restricted human cause and apology."];
  f.row.evidence = [...f.records.keys()];
  f.row.accessGap = { evidence: [...f.records.keys()] };
  const projected = projectIngestionAccessGap(f.row, f.get), serialized = JSON.stringify(projected);
  for (const id of f.records.keys()) {
    assert.equal(serialized.includes(id), false, "Public gap metadata should omit private capture IDs.");
  }
  assert.equal(serialized.includes("Restricted human"), false, "Public gap metadata should omit restricted observations.");
  assert.equal(serialized.includes("Private note"), false, "Public gap metadata should omit private context notes.");
  assert.equal(projected.complete, false, "A gap projection should not claim a completed content read.");
  assert.equal(projected.externalComplete, false, "A gap projection should preserve unavailable external content.");
  assert.equal(projected.status, INGESTION_ACCESS_GAP_STATUS, "Public metadata should retain the explicit gap status.");
  assert.equal(projected.accessGap.contexts.length, 2, "The public gap should identify both denied URLs.");
  assert.deepEqual(f.row.bugs, before.bugs, "Projection should preserve the original private contexts.");
});
