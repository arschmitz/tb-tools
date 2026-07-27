import {
  BUGZILLA_BUG_URL,
  COMMIT_MESSAGE_LINK_PATTERN,
  INTERACTIVE,
  PHABRICATOR_REVISION_URL,
  graphStates,
} from "./config.js";
import { isWorkingTreeCommit } from "./commit-model.js";
import { updateCommitRowStates } from "./lane-renderer.js";
import { showDiff } from "./commit-actions.js";

export function setDiffText(body, text) {
  const placeholder = document.createElement("pre");
  placeholder.className = "diff-placeholder";
  placeholder.textContent = text;
  body.replaceChildren(placeholder);
}

export function setDiffHtml(body, html) {
  body.innerHTML = html;
}

export function formatDiffChangeCountLabel(insertions, deletions) {
  const additionLabel = insertions === 1 ? "addition" : "additions";
  const deletionLabel = deletions === 1 ? "deletion" : "deletions";

  return insertions + " " + additionLabel + " and " + deletions + " " + deletionLabel;
}

export function setDiffStats(stats, diff) {
  const insertions = Number(diff && diff.insertions);
  const deletions = Number(diff && diff.deletions);

  if (!Number.isFinite(insertions) || !Number.isFinite(deletions)) {
    stats.hidden = true;
    stats.setAttribute("aria-label", "");
    stats.querySelector(".stat-additions").textContent = "";
    stats.querySelector(".stat-deletions").textContent = "";
    return;
  }

  stats.hidden = false;
  stats.setAttribute("aria-label", formatDiffChangeCountLabel(insertions, deletions));
  stats.querySelector(".stat-additions").textContent = "+" + insertions;
  stats.querySelector(".stat-deletions").textContent = "-" + deletions;
}

export function clearDiffSelection(index, message = "Select a commit in the graph.") {
  const viewer = document.getElementById("diff-" + index);

  if (!viewer) {
    return;
  }

  graphStates[index].selectedHash = "";
  viewer.querySelector(".diff-title").textContent = "No commit selected";
  viewer.querySelector(".diff-meta").textContent = "";
  setCommitMessage(viewer.querySelector(".diff-message"), "");
  viewer.querySelector(".checkout-commit").hidden = true;
  viewer.querySelector(".amend-commit").hidden = true;
  viewer.querySelector(".submit-commit").hidden = true;
  clearIntegrationStatus(viewer.querySelector(".integration-status"));
  viewer.querySelector(".checkout-status").textContent = "";
  setDiffStats(viewer.querySelector(".diff-stats"), null);
  setDiffText(viewer.querySelector(".diff-body"), message);
  updateCommitRowStates(index);
}

export function setCommitMessage(messageElement, message = "") {
  const text = String(message || "").trimEnd();

  messageElement.replaceChildren(...getLinkedCommitMessageNodes(text));
  messageElement.hidden = !text;
}

export function getCommitMessageLinkUrl(text) {
  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  const bugMatch = /^bug\s+#?(\d{4,8})$/i.exec(text);
  if (bugMatch) {
    return BUGZILLA_BUG_URL + bugMatch[1];
  }

  const phabMatch = /^(?:phab-)?D(\d{4,})$/i.exec(text);
  if (phabMatch) {
    return PHABRICATOR_REVISION_URL + phabMatch[1];
  }

  return "";
}

export function splitLinkTrailingPunctuation(text) {
  const match = /^(.*?)([.,;:)]+)?$/.exec(text);

  if (!match) {
    return [text, ""];
  }

  return [match[1], match[2] || ""];
}

export function getLinkedCommitMessageNodes(message) {
  const nodes = [];
  let index = 0;

  for (const match of message.matchAll(COMMIT_MESSAGE_LINK_PATTERN)) {
    const rawText = match[0];
    const start = match.index || 0;

    if (start > index) {
      nodes.push(document.createTextNode(message.slice(index, start)));
    }

    const [linkText, trailingText] = splitLinkTrailingPunctuation(rawText);
    const href = getCommitMessageLinkUrl(linkText);

    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = linkText;
      nodes.push(link);
    } else {
      nodes.push(document.createTextNode(linkText));
    }

    if (trailingText) {
      nodes.push(document.createTextNode(trailingText));
    }

    index = start + rawText.length;
  }

  if (index < message.length) {
    nodes.push(document.createTextNode(message.slice(index)));
  }

  return nodes;
}

export function clearIntegrationStatus(container) {
  if (!container) {
    return;
  }

  container.hidden = true;
  container.replaceChildren();
}

export function getBugStatusClass(bug) {
  if (bug.error) {
    return "error";
  }

  const status = String(bug.status || "").toLowerCase();
  const resolution = String(bug.resolution || "").toLowerCase();

  if (bug.isOpen === true || ["unconfirmed", "new", "assigned", "reopened"].includes(status)) {
    return "open";
  }

  if (bug.isOpen === false || resolution && resolution !== "---" || ["resolved", "verified", "closed"].includes(status)) {
    return "closed";
  }

  return "";
}

export function getPhabricatorStatusClass(revision) {
  if (revision.error) {
    return "error";
  }

  const status = String(revision.statusName || revision.status || "").toLowerCase();

  if (/accepted|closed|landed/.test(status)) {
    return "accepted";
  }

  if (/abandoned|rejected/.test(status)) {
    return "warning";
  }

  if (/review|draft|open|planned/.test(status)) {
    return "open";
  }

  return "";
}

export function isAcceptedPhabricatorStatus(revision) {
  if (!revision || revision.error) {
    return false;
  }

  const status = String((revision.statusName || "") + " " + (revision.status || "")).toLowerCase();

  return /\baccepted\b/.test(status) || /status-accepted/.test(status);
}

export function getBugStatusText(bug) {
  return [bug.status, bug.resolution && bug.resolution !== "---" ? bug.resolution : ""]
    .filter(Boolean)
    .join(" ");
}

export function createStatusBadge({ label, url, status, detail, className = "" }) {
  const badge = url ? document.createElement("a") : document.createElement("span");
  badge.className = ["status-badge", className].filter(Boolean).join(" ");

  if (url) {
    badge.href = url;
    badge.target = "_blank";
    badge.rel = "noreferrer";
  }

  const labelNode = document.createElement("strong");
  labelNode.textContent = label;
  badge.append(labelNode);

  if (status) {
    const statusNode = document.createElement("span");
    statusNode.className = "status-value";
    statusNode.textContent = status;
    badge.append(statusNode);
  }

  if (detail) {
    const detailNode = document.createElement("span");
    detailNode.className = "status-detail";
    detailNode.textContent = detail;
    badge.append(detailNode);
  }

  return badge;
}

export function createCheckinNeededButton({ bug, index, commit }) {
  const button = document.createElement("button");
  button.className = "checkin-needed-button";
  button.type = "button";
  button.dataset.graphIndex = String(index);
  button.dataset.hash = commit.hash;
  button.dataset.bugId = bug.id;
  button.textContent = bug.hasCheckinNeeded ? "Marked for checkin" : "Mark for checkin";
  button.disabled = Boolean(bug.hasCheckinNeeded);

  return button;
}

export function formatTryRunDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function createTryRunBadge(tryRun, label) {
  return createStatusBadge({
    label,
    url: tryRun.url,
    status: formatTryRunDate(tryRun.createdAt),
    detail: tryRun.subject || "",
    className: "try",
  });
}

export function createTryRunStatus(tryRuns = []) {
  const runs = Array.isArray(tryRuns) ? tryRuns.filter((tryRun) => tryRun && tryRun.url) : [];

  if (!runs.length) {
    return null;
  }

  const group = document.createElement("span");
  group.className = "try-run-group";
  group.append(createTryRunBadge(runs[0], "Try"));

  if (runs.length > 1) {
    const toggle = document.createElement("button");
    const history = document.createElement("span");

    toggle.className = "try-run-toggle";
    toggle.type = "button";
    toggle.textContent = ">";
    toggle.setAttribute("aria-label", "Show older try runs");
    toggle.setAttribute("aria-expanded", "false");

    history.className = "try-run-history";
    history.hidden = true;
    runs.slice(1).forEach((tryRun, index) => {
      history.append(createTryRunBadge(tryRun, "Try " + (index + 2)));
    });

    toggle.addEventListener("click", () => {
      history.hidden = !history.hidden;
      toggle.textContent = history.hidden ? ">" : "v";
      toggle.setAttribute("aria-expanded", history.hidden ? "false" : "true");
      toggle.setAttribute("aria-label", history.hidden ? "Show older try runs" : "Hide older try runs");
    });

    group.append(toggle, history);
  }

  return group;
}

export function renderCommitIntegrationStatus(container, result, { index, commit }) {
  const badges = [];
  const tryRunStatus = createTryRunStatus(result.tryRuns || commit.tryRuns);

  if (tryRunStatus) {
    badges.push(tryRunStatus);
  }

  if (result.bug) {
    badges.push(createStatusBadge({
      label: "Bug " + result.bug.id,
      url: result.bug.url,
      status: result.bug.error ? "Unavailable" : getBugStatusText(result.bug),
      detail: result.bug.error || result.bug.summary,
      className: getBugStatusClass(result.bug),
    }));

    if (!result.bug.error && isAcceptedPhabricatorStatus(result.phabricator)) {
      badges.push(createCheckinNeededButton({
        bug: result.bug,
        index,
        commit,
      }));
    }
  }

  if (result.phabricator) {
    badges.push(createStatusBadge({
      label: result.phabricator.revision,
      url: result.phabricator.url,
      status: result.phabricator.error ? "Unavailable" : result.phabricator.statusName || result.phabricator.status,
      detail: result.phabricator.error || result.phabricator.title,
      className: getPhabricatorStatusClass(result.phabricator),
    }));
  }

  if (!badges.length) {
    clearIntegrationStatus(container);
    return;
  }

  container.replaceChildren(...badges);
  container.hidden = false;
}

export async function loadSelectedCommitIntegrationStatus(index, commit, container) {
  if (!INTERACTIVE.enabled) {
    clearIntegrationStatus(container);
    return;
  }

  if (isWorkingTreeCommit(commit)) {
    renderCommitIntegrationStatus(container, { tryRuns: commit.tryRuns || [] }, { index, commit });
    return;
  }

  container.hidden = false;
  container.textContent = "Loading linked Bugzilla and Phabricator status...";

  try {
    const response = await fetch(
      "/api/graph/" + index + "/integration/" + encodeURIComponent(commit.hash) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (graphStates[index].selectedHash !== commit.hash) {
      return;
    }

    renderCommitIntegrationStatus(container, result, { index, commit });
  } catch (error) {
    if (graphStates[index].selectedHash === commit.hash) {
      container.replaceChildren(createStatusBadge({
        label: "Integrations",
        status: "Unavailable",
        detail: error && error.message ? error.message : String(error),
        className: "error",
      }));
      container.hidden = false;
    }
  }
}

export async function markBugForCheckin(button) {
  const graphIndex = Number(button.dataset.graphIndex);
  const hash = button.dataset.hash;
  const bugId = button.dataset.bugId;
  const viewer = document.getElementById("diff-" + graphIndex);
  const status = viewer.querySelector(".checkout-status");
  const container = viewer.querySelector(".integration-status");

  if (!confirm("Add checkin-needed-tb to Bug " + bugId + "?")) {
    return;
  }

  button.disabled = true;
  button.textContent = "Marking...";
  status.classList.remove("error");
  status.textContent = "Marking Bug " + bugId + " for checkin...";

  try {
    const response = await fetch("/api/bugzilla/checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex,
        hash,
        bugId,
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (graphStates[graphIndex].selectedHash === hash) {
      const commit = graphStates[graphIndex].commits.find((item) => item.hash === hash);

      if (commit) {
        renderCommitIntegrationStatus(container, result, { index: graphIndex, commit });
      }
    }

    status.textContent = result.message || "Bug " + bugId + " marked for checkin.";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Mark for checkin";
    status.classList.add("error");
    status.textContent = error && error.message ? error.message : String(error);
  }
}

export async function loadSelectedCommitMessage(index, commit, messageElement) {
  if (!INTERACTIVE.enabled || isWorkingTreeCommit(commit)) {
    setCommitMessage(messageElement, "");
    return;
  }

  setCommitMessage(messageElement, "Loading commit message...");

  try {
    const response = await fetch(
      "/api/graph/" + index + "/message/" + encodeURIComponent(commit.hash) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (graphStates[index].selectedHash !== commit.hash) {
      return;
    }

    setCommitMessage(messageElement, result.message || commit.subject);
  } catch (error) {
    if (graphStates[index].selectedHash === commit.hash) {
      setCommitMessage(messageElement, "Could not load commit message: " + (error && error.message ? error.message : String(error)));
    }
  }
}

export function selectCommitActionResult(index, hash, message) {
  const state = graphStates[index];
  const viewer = document.getElementById("diff-" + index);
  const commit = hash ? state.commits.find((item) => item.hash === hash) : null;

  if (!commit) {
    clearDiffSelection(index, message);
    return;
  }

  showDiff(state.graph, index, commit);
  viewer.querySelector(".checkout-status").textContent = message || "";
}
