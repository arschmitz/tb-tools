// Keep browser page parsing separate from session and sign-in management.
export async function loadWebReviewDiffs(page) {
  const changesets = page.locator("[data-sigil~='differential-changeset']");
  for (let index = 0; index < await changesets.count(); index++) {
    const changeset = changesets.nth(index);
    await changeset.evaluate((node) => {
      globalThis.JX.DiffChangeset.getForNode(node).load();
    });
    await changeset.locator(".differential-loading").waitFor({ state: "hidden", timeout: 30000 });
  }
}

export async function readWebReview(page, revision) {
  // Expand history one page at a time. Never return a silent partial history.
  for (let count = 0; ; count++) {
    const older = page.locator("a[href*='/transactions/showolder/']");
    if (!await older.count()) {
      break;
    }
    if (count >= 20) {
      throw new Error("Phabricator history exceeds 20 pages. Open the revision to inspect the remaining history.");
    }
    const href = await older.first().getAttribute("href");
    await older.first().click();
    await page.waitForFunction((oldHref) => !Array.from(globalThis.document.querySelectorAll("a"))
      .some((a) => a.getAttribute("href") === oldHref), href);
  }
  await loadWebReviewDiffs(page);
  return page.evaluate((id) => {
    const document = globalThis.document;
    const text = (node) => node?.textContent?.trim() || "";
    const data = (node) => globalThis.JX.Stratcom.getData(node);
    const inlineComments = new Map();
    const revisionAuthors = new Set();
    for (const node of document.querySelectorAll("[data-sigil~='differential-inline-comment']")) {
      const meta = data(node);
      if (!meta.phid || meta.isSynthetic || meta.isDraft) {
        continue;
      }
      const changeset = node.closest("[data-sigil~='differential-changeset']");
      if (!changeset) {
        continue;
      }
      const state = meta.state?.committed || meta.state?.active;
      if (!state) {
        throw new Error("Phabricator did not provide the inline comment content state.");
      }
      const authorNode = node.querySelector(".inline-head-left")?.cloneNode(true);
      const isRevisionAuthor = Array.from(authorNode?.querySelectorAll(".phui-tag-view") || [])
        .some((tag) => text(tag) === "Author");
      authorNode?.querySelectorAll(".phui-tag-view, .phui-badge-view").forEach((tag) => tag.remove());
      const author = text(authorNode) || String(meta.snippet || "").split(":")[0];
      if (isRevisionAuthor) {
        revisionAuthors.add(author);
      }
      const side = meta.isNewFile ? "new" : "old";
      const comment = {
        id: meta.phid,
        commentId: String(meta.id),
        author,
        isRevisionAuthor,
        content: String(state.text || ""),
        codeSuggestion: state.hasSuggestion
          ? { content: String(state.suggestionText || ""), isDeletion: !state.suggestionText }
          : null,
        filePath: data(changeset).symbolPath || text(changeset.querySelector("[data-sigil~='changeset-header-path-name']")),
        changesetId: Number(meta.changesetID),
        isNewFile: Boolean(meta.isNewFile),
        contextLineSide: side,
        lineNumber: Number(meta.number),
        lineLength: Number(meta.length) + 1,
        done: Boolean(meta.isFixed),
        replyToCommentPHID: meta.replyToCommentPHID || "",
        url: `${globalThis.location.origin}/${id}#inline-${meta.id}`,
      };
      if (!inlineComments.has(meta.phid) || !meta.isGhost) {
        inlineComments.set(meta.phid, comment);
      }
    }
    const comments = [];
    for (const event of document.querySelectorAll(".phui-timeline-event-view")) {
      const content = event.querySelector(".phui-timeline-content .phabricator-remarkup");
      if (!text(content) || content.closest("[data-sigil~='differential-inline-comment']")) {
        continue;
      }
      const link = event.querySelector("a[href*='#']");
      const author = text(event.querySelector(".phui-timeline-title .phui-handle"));
      comments.push({
        id: event.id || link?.getAttribute("href") || `web-comment-${comments.length}`,
        content: text(content),
        author,
        isRevisionAuthor: revisionAuthors.has(author),
        url: link?.href || globalThis.location.href,
      });
    }
    const rawLink = Array.from(document.querySelectorAll("a[href]"))
      .find((a) => new URL(a.href).searchParams.get("download") === "true");
    return { available: true, revision: id, url: globalThis.location.href,
      comments, inlineComments: [...inlineComments.values()], historyTruncated: false,
      rawUrl: rawLink?.href || "" };
  }, revision);
}

export async function saveWebInline(page, options) {
  await loadWebReviewDiffs(page);
  return page.evaluate(async ({ revision, filePath, lineNumber, lineLength = 1,
    content, hasSuggestion = false, suggestionText = "", commentPHID }) => {
    const document = globalThis.document;
    const data = (node) => globalThis.JX.Stratcom.getData(node);
    const form = document.querySelector("form[data-sigil~='transaction-append']");
    if (!form) {
      throw new Error("Phabricator did not provide the comment form.");
    }
    let anchor;
    if (commentPHID) {
      const candidates = Array.from(document.querySelectorAll("[data-sigil~='differential-inline-comment']"))
        .filter((candidate) => data(candidate).phid === commentPHID);
      const node = candidates.find((candidate) => !data(candidate).isGhost) || candidates[0];
      anchor = node && data(node);
      if (!anchor || !anchor.isNewFile) {
        throw new Error("The parent comment is not on the current new/right side. No draft was posted.");
      }
    } else {
      const node = Array.from(document.querySelectorAll("[data-sigil~='differential-changeset']"))
        .find((candidate) => data(candidate).symbolPath === filePath);
      if (!node || !Number.isInteger(lineNumber) || lineNumber < 1) {
        throw new Error("The requested file and new-side line are not available in this patch.");
      }
      anchor = { changesetID: data(node).right, number: lineNumber, length: Math.max(0, lineLength - 1) };
    }
    const csrf = String(new FormData(form).get("__csrf__") || "");
    const fields = { changesetID: anchor.changesetID, number: anchor.number, length: anchor.length,
      is_new: "1", on_right: "1", renderer: "2up", hasContentState: "1",
      hasSuggestion: hasSuggestion ? "1" : "0", suggestionText, text: content };
    const request = async (extra) => {
      const body = new FormData();
      for (const [key, value] of Object.entries({ ...fields, ...extra, __csrf__: csrf })) {
        body.set(key, String(value));
      }
      const response = await fetch(`/differential/comment/inline/edit/${revision.replace(/^D/, "")}/`, {
        method: "POST", credentials: "same-origin", body,
        headers: { "X-Requested-With": "XMLHttpRequest", "X-Phabricator-CSRF": csrf },
      });
      if (!response.ok) {
        throw new Error(`Phabricator inline save failed (${response.status}). Do not retry until you check the revision.`);
      }
      const result = JSON.parse((await response.text()).replace(/^for\s*\(;;\);\s*/, ""));
      if (result.error || result.error_info) {
        throw new Error("Phabricator rejected the inline draft. Check the revision before retrying.");
      }
      return result.payload || result;
    };
    const created = await request(commentPHID
      ? { op: "reply", replyToCommentPHID: commentPHID }
      : { op: "new" });
    const inlineId = Number(created.inline?.id);
    if (!Number.isInteger(inlineId) || inlineId < 1) {
      throw new Error("Phabricator did not return a draft ID. Check the revision before retrying.");
    }
    const saved = await request({ op: "save", id: inlineId });
    const committed = saved.inline?.state?.committed;
    const normalizeLines = (value) => String(value ?? "").replace(/\r\n/g, "\n");
    if (Number(saved.inline?.id) !== inlineId || !committed || normalizeLines(committed.text) !== normalizeLines(content) ||
        Boolean(committed.hasSuggestion) !== hasSuggestion ||
        (hasSuggestion && normalizeLines(committed.suggestionText) !== normalizeLines(suggestionText))) {
      throw new Error("Phabricator did not confirm the saved draft. Check the revision before retrying.");
    }
    return { inlineId, revision, parentCommentPHID: commentPHID || "" };
  }, options);
}

export async function markWebInlineDone(page, { revision, commentPHID }) {
  await loadWebReviewDiffs(page);
  return page.evaluate(async ({ revision, commentPHID }) => {
    const document = globalThis.document;
    const metadata = Array.from(document.querySelectorAll("[data-sigil~='differential-inline-comment']"))
      .map((node) => globalThis.JX.Stratcom.getData(node))
      .find((entry) => entry.phid === commentPHID);
    if (!metadata) {
      throw new Error("Phabricator did not provide this inline comment. Nothing was marked done.");
    }
    if (metadata.isFixed) {
      return { checked: true };
    }
    const form = document.querySelector("form[data-sigil~='transaction-append']");
    if (!form) {
      throw new Error("Phabricator did not provide the comment form.");
    }
    const csrf = new FormData(form).get("__csrf__");
    const body = new FormData();
    body.set("__csrf__", csrf);
    body.set("op", "done");
    body.set("id", metadata.id);
    const response = await fetch(`/differential/comment/inline/edit/${revision.replace(/^D/, "")}/`, {
      method: "POST", credentials: "same-origin", body,
      headers: { "X-Requested-With": "XMLHttpRequest", "X-Phabricator-CSRF": csrf },
    });
    if (!response.ok) {
      throw new Error(`Phabricator could not mark the comment done (${response.status}).`);
    }
    const result = JSON.parse((await response.text()).replace(/^for\s*\(;;\);\s*/, ""));
    if ((result.payload || result).isChecked !== true) {
      throw new Error("Phabricator did not confirm the comment as done. Check the revision before retrying.");
    }
    return { checked: true };
  }, { revision, commentPHID });
}

export async function publishWebReview(page, { action, message }) {
  const form = page.locator("form[data-sigil~='transaction-append']");
  const savedActionCount = await form.locator(".phui-comment-action").count();
  const pendingActions = await form.locator("select option:disabled").evaluateAll((options) =>
    options.map((option) => option.value));
  const reuseAction = action !== "comment" && savedActionCount === 1 &&
    pendingActions.length === 1 && pendingActions[0] === action;
  if (savedActionCount && !reuseAction) {
    throw new Error("The web form has a saved review action. Check it in Phabricator before submitting from the console.");
  }
  if (action !== "comment" && !reuseAction) {
    const select = form.locator("select").filter({ has: page.locator(`option[value='${action}']`) }).first();
    if (!await select.count()) {
      throw new Error(`Phabricator does not offer ${action} for this revision. Nothing was posted.`);
    }
    await select.selectOption(action);
    await page.waitForFunction((selectedAction) => Array.from(globalThis.document.querySelectorAll("select option"))
      .some((option) => option.value === selectedAction && option.disabled), action);
  }
  if (action === "accept") {
    const choices = form.locator(".phui-comment-action input[type='checkbox']");
    if (await choices.count()) {
      const personalChoices = await choices.evaluateAll(nodes => nodes.flatMap((node, index) => {
        const label = [...node.labels || []].map(label => label.textContent).join(" ").trim();
        return node.value.startsWith("PHID-USER-") && /^Accept as\s/i.test(label) ? [index] : [];
      }));
      if (personalChoices.length !== 1) {
        throw new Error("Phabricator did not offer one personal acceptance option. Nothing was posted.");
      }
      // Native checkbox controls are serialized by Phabricator when the form submits.
      // Clear group, package, and forced reviewer approvals, including saved defaults.
      for (let index = 0; index < await choices.count(); index++) {
        await choices.nth(index).setChecked(index === personalChoices[0]);
      }
      const checked = await choices.evaluateAll(nodes => nodes.flatMap((node, index) => node.checked ? [index] : []));
      if (checked.length !== 1 || checked[0] !== personalChoices[0]) {
        throw new Error("Phabricator did not confirm personal-only acceptance. Nothing was posted.");
      }
    }
  }
  const input = form.locator("textarea[name='comment']");
  const existingDraft = await input.inputValue();
  const finalText = existingDraft.trim() && message.trim() && existingDraft.trim() !== message.trim()
    ? `${existingDraft}\n\n${message}`
    : message || existingDraft;
  await input.fill(finalText);
  const before = await page.locator(".phui-timeline-event-view a.phabricator-anchor-view[id]").evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.id).filter((id) => /^\d+$/.test(id)));
  await form.locator("button[data-sigil~='submit-transactions']").click();
  // Phabricator can remove the chosen action after it posts. Confirm the new
  // timeline event and cleared form instead of waiting for that option to return.
  await page.waitForFunction(({ previous, action }) => {
    const document = globalThis.document;
    const newEntries = Array.from(document.querySelectorAll(".phui-timeline-event-view"))
      .filter((event) => Array.from(event.querySelectorAll("a.phabricator-anchor-view[id]"))
        .some((anchor) => /^\d+$/.test(anchor.id) && !previous.includes(anchor.id)));
    const form = document.querySelector("form[data-sigil~='transaction-append']");
    const postedAction = newEntries.some((event) => {
      const title = event.querySelector(".phui-timeline-title")?.textContent || "";
      return action === "comment" ||
        (action === "accept" && /accepted this revision\b/i.test(title)) ||
        (action === "reject" && /requested changes to this revision\b/i.test(title));
    });
    return postedAction && !document.querySelector(".aphront-dialog-view") &&
      form?.querySelector("textarea[name='comment']")?.value === "";
  }, { previous: before, action }, { timeout: 30000 }).catch(() => {
    throw new Error("Phabricator did not confirm the review submission. Check the revision before retrying.");
  });
}
