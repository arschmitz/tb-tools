import {
  BRANCH_LABEL_GAP,
  BRANCH_LABEL_HEIGHT,
  BRANCH_LABEL_PADDING_X,
  BRANCH_LABEL_TEXT_WIDTH,
  COMMIT_DOT_RADIUS,
  COMMIT_HASH_WIDTH,
  COMMIT_ROW_HEIGHT,
  COMMIT_ROW_HORIZONTAL_INSET,
  COMMIT_SUBJECT_GAP,
  INTERACTIVE,
  LANE_COLORS,
  LANE_LEFT,
  LANE_MESSAGE_GAP,
  LANE_SPACING,
  LANE_TOP,
  SVG_NS,
  contextMenu,
  graphStates,
  uiState,
} from "./config.js";
import {
  getCurrentCommitHash,
  getStateSnapshotFingerprint,
  isCurrentCommit,
  isWorkingTreeCommit,
  placeWorkingTreeCommits,
  pruneLoadedParents,
} from "./commit-model.js";
import { getGraphContainer, setGraphSummary } from "./dom.js";
import { showDiff } from "./commit-actions.js";

export function getTranslate(node) {
  const match = (node.getAttribute("transform") || "").match(/translate\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);

  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
  };
}

export function setTranslate(node, x, y) {
  node.setAttribute("transform", "translate(" + Number(x.toFixed(2)) + ", " + Number(y.toFixed(2)) + ")");
}

export function centerBranchLabelsVertically(index) {
  const container = getGraphContainer(index);

  for (const text of container.querySelectorAll("svg text")) {
    const labelGroup = text.parentElement;
    const labelContainer = labelGroup && labelGroup.parentElement;
    const labelTransform = labelContainer && labelContainer.getAttribute("transform");

    if (
      !labelGroup ||
      !labelContainer ||
      !labelTransform ||
      !labelGroup.firstElementChild ||
      labelGroup.firstElementChild.tagName.toLowerCase() !== "rect"
    ) {
      continue;
    }

    let labelBounds;

    try {
      labelBounds = labelGroup.getBBox();
    } catch {
      continue;
    }

    if (!labelBounds.width || !labelBounds.height) {
      continue;
    }

    const labelTranslate = getTranslate(labelContainer);
    const labelY = COMMIT_DOT_RADIUS - labelBounds.y - labelBounds.height / 2;

    setTranslate(labelContainer, labelTranslate.x, labelY);
  }
}

export function updateCommitRowStates(index) {
  const container = getGraphContainer(index);
  const { currentHash, selectedHash } = graphStates[index];

  for (const row of container.querySelectorAll(".commit-row")) {
    row.classList.toggle("active", row.dataset.hash === selectedHash);
    row.classList.toggle("current", row.dataset.hash === currentHash);
  }
}

export function getCommitRowsWidth(container, svg) {
  let width = container.clientWidth || 0;
  const hitboxes = Array.from(container.querySelectorAll(".commit-row-hitbox"));

  for (const hitbox of hitboxes) {
    hitbox.setAttribute("visibility", "hidden");
  }

  try {
    width = Math.max(width, svg.getBBox().width + COMMIT_ROW_HORIZONTAL_INSET * 2);
  } catch {
    // The graph may be between render passes; the next scheduled pass will retry.
  } finally {
    for (const hitbox of hitboxes) {
      hitbox.removeAttribute("visibility");
    }
  }

  return Math.max(width, 1);
}

export function getLaneX(lane) {
  return LANE_LEFT + lane * LANE_SPACING;
}

export function getLaneY(rowIndex) {
  return LANE_TOP + rowIndex * 30;
}

export function normalizeBranchRef(ref = "") {
  return String(ref)
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^remotes\//, "")
    .trim();
}

export function isBranchRef(ref = "") {
  const branch = normalizeBranchRef(ref);

  return Boolean(
    branch &&
    branch !== "HEAD" &&
    branch !== "uncommitted" &&
    !branch.startsWith("tag: ") &&
    !branch.endsWith("/HEAD")
  );
}

export function getCommitBranchRefs(commit) {
  if (!commit || !Array.isArray(commit.refs)) {
    return [];
  }

  return Array.from(new Set(commit.refs
    .filter(isBranchRef)
    .map(normalizeBranchRef)));
}

export function getPrioritizedCommitBranchRefs(index, commit) {
  const branches = getCommitBranchRefs(commit);
  const currentBranch = normalizeBranchRef(graphStates[index]?.graph?.branch || "");

  if (!currentBranch || !branches.includes(currentBranch)) {
    return branches;
  }

  return [
    currentBranch,
    ...branches.filter((branch) => branch !== currentBranch),
  ];
}

export function getPrimaryBranchRef(index, commit) {
  return getPrioritizedCommitBranchRefs(index, commit)[0] || "";
}

export function getBranchColor(index, branch, fallbackIndex = 0) {
  const name = normalizeBranchRef(branch);

  if (!name) {
    return LANE_COLORS[fallbackIndex % LANE_COLORS.length];
  }

  const state = graphStates[index];

  if (!state.branchColors.has(name)) {
    state.branchColors.set(name, LANE_COLORS[state.nextBranchColorIndex % LANE_COLORS.length]);
    state.nextBranchColorIndex++;
  }

  return state.branchColors.get(name);
}

export function getColorTint(color, alpha) {
  const match = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);

  if (!match) {
    return color;
  }

  return "rgba(" + parseInt(match[1], 16) + ", " + parseInt(match[2], 16) + ", " + parseInt(match[3], 16) + ", " + alpha + ")";
}

export function getLaneColor(index, branch, lane) {
  return getBranchColor(index, branch, lane);
}

export function getKnownParentHashes(commits, commit) {
  const knownHashes = new Set(commits.map(({ hash }) => hash));

  return (commit.parents || []).filter((parent) => knownHashes.has(parent));
}

export function getLaneRows(index, commits) {
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  let lanes = [];
  let maxLaneCount = 1;

  return commits.map((commit, rowIndex) => {
    let lane = lanes.findIndex(({ hash }) => hash === commit.hash);
    const explicitBranch = getPrimaryBranchRef(index, commit);

    if (lane === -1) {
      lanes.push({
        hash: commit.hash,
        branch: explicitBranch,
      });
      lane = lanes.length - 1;
    } else if (explicitBranch) {
      lanes[lane] = {
        ...lanes[lane],
        branch: explicitBranch,
      };
    }

    const lanesBefore = lanes.map((item) => ({ ...item }));
    const branch = explicitBranch || lanesBefore[lane]?.branch || "";
    const parents = getKnownParentHashes(commits, commit);
    const lanesAfter = lanesBefore
      .filter((item, index) => index !== lane)
      .map((item) => ({ ...item }));
    const parentItems = parents
      .filter((parent, parentIndex) => parents.indexOf(parent) === parentIndex)
      .map((parent, parentIndex) => {
        const existing = lanesAfter.find((item) => item.hash === parent);
        const parentBranch = getPrimaryBranchRef(index, commitsByHash.get(parent)) || (parentIndex === 0 ? branch : "");

        if (existing) {
          if (parentBranch && !existing.branch) {
            existing.branch = parentBranch;
          }
          return null;
        }

        return {
          hash: parent,
          branch: parentBranch,
        };
      })
      .filter(Boolean);

    lanesAfter.splice(lane, 0, ...parentItems);

    maxLaneCount = Math.max(maxLaneCount, lanesBefore.length, lanesAfter.length);
    lanes = lanesAfter;

    return {
      commit,
      rowIndex,
      lane,
      branch,
      lanesBefore,
      lanesAfter,
      parents,
      get maxLaneCount() {
        return maxLaneCount;
      },
    };
  });
}

export function createSvgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);

  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  });

  return node;
}

export function getLanePathD(fromLane, fromRow, toLane, toRow) {
  const fromX = getLaneX(fromLane);
  const fromY = getLaneY(fromRow);
  const toX = getLaneX(toLane);
  const toY = getLaneY(toRow);

  if (fromX === toX) {
    return "M " + fromX + " " + fromY + " L " + toX + " " + toY;
  }

  const midY = fromY + (toY - fromY) / 2;

  return [
    "M " + fromX + " " + fromY,
    "C " + fromX + " " + midY + " " + toX + " " + midY + " " + toX + " " + toY,
  ].join(" ");
}

export function drawLanePath(svg, index, fromLane, fromRow, toLane, toRow, branch) {
  const path = createSvgElement("path", {
    class: "lane-path",
    d: getLanePathD(fromLane, fromRow, toLane, toRow),
    stroke: getLaneColor(index, branch, fromLane),
    "stroke-width": 4,
  });

  svg.append(path);
}

export function drawLaneContinuations(svg, index, row, rowCount) {
  if (row.rowIndex >= rowCount - 1) {
    return;
  }

  row.lanesBefore.forEach((laneState, beforeLane) => {
    if (laneState.hash === row.commit.hash) {
      return;
    }

    const afterLane = row.lanesAfter.findIndex(({ hash }) => hash === laneState.hash);

    if (afterLane === -1) {
      return;
    }

    drawLanePath(svg, index, beforeLane, row.rowIndex, afterLane, row.rowIndex + 1, laneState.branch || row.lanesAfter[afterLane]?.branch);
  });

  row.parents.forEach((parent) => {
    const afterLane = row.lanesAfter.findIndex(({ hash }) => hash === parent);

    if (afterLane !== -1) {
      drawLanePath(svg, index, row.lane, row.rowIndex, afterLane, row.rowIndex + 1, row.lanesAfter[afterLane]?.branch || row.branch);
    }
  });
}

export function getCommitForMessage(text, commits) {
  const abbrev = (text.textContent || "").split(" ")[0];

  return commits.find((commit) => commit.hash.startsWith(abbrev) || commit.hash.substring(0, 7) === abbrev);
}

export function hideCommitContextMenu() {
  contextMenu.hidden = true;
  uiState.contextMenuState = null;
}

export function showCommitContextMenu(event, index, commit) {
  if (!INTERACTIVE.enabled) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const workingTree = isWorkingTreeCommit(commit);

  uiState.contextMenuState = {
    graphIndex: index,
    hash: commit.hash,
    label: graphStates[index].graph.label,
    subject: commit.subject,
    workingTree,
  };
  contextMenu.querySelectorAll("button[data-action]").forEach((button) => {
    const hidden = workingTree ? button.dataset.action !== "prune" : false;

    button.hidden = hidden;
    button.style.display = hidden ? "none" : "";
  });
  contextMenu.querySelector(".context-menu-title").textContent = workingTree
    ? "Uncommitted changes"
    : commit.hash.substring(0, 12) + " " + commit.subject;
  contextMenu.hidden = false;

  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - 8));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 8));
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
  contextMenu.querySelector("button:not([hidden])")?.focus();
}

export function ensureCommitRowHitbox(commitGroup, width) {
  let hitbox = Array.from(commitGroup.children).find((node) => node.classList.contains("commit-row-hitbox"));
  const commitTranslate = getTranslate(commitGroup);

  if (!hitbox) {
    hitbox = document.createElementNS(SVG_NS, "rect");
    hitbox.classList.add("commit-row-hitbox");
    commitGroup.insertBefore(hitbox, commitGroup.firstChild);
  }

  hitbox.setAttribute("x", String(-commitTranslate.x - COMMIT_ROW_HORIZONTAL_INSET));
  hitbox.setAttribute("y", String(COMMIT_DOT_RADIUS - COMMIT_ROW_HEIGHT / 2));
  hitbox.setAttribute("width", String(width));
  hitbox.setAttribute("height", String(COMMIT_ROW_HEIGHT));
  hitbox.setAttribute("rx", "5");

  return hitbox;
}

export function getBranchLabelWidth(branch) {
  return Math.max(28, branch.length * BRANCH_LABEL_TEXT_WIDTH + BRANCH_LABEL_PADDING_X * 2);
}

export function addBranchLabels(group, index, commit, x, y, fallbackLane) {
  let nextX = x;

  for (const branch of getPrioritizedCommitBranchRefs(index, commit)) {
    const color = getBranchColor(index, branch, fallbackLane);
    const labelWidth = getBranchLabelWidth(branch);
    const rect = createSvgElement("rect", {
      class: "branch-label-bg",
      x: nextX,
      y: y - BRANCH_LABEL_HEIGHT / 2,
      width: labelWidth,
      height: BRANCH_LABEL_HEIGHT,
      rx: 3,
      fill: getColorTint(color, 0.15),
      stroke: getColorTint(color, 0.58),
    });
    const label = createSvgElement("text", {
      class: "branch-label-text",
      x: nextX + BRANCH_LABEL_PADDING_X,
      y,
      fill: color,
    });

    label.textContent = branch;
    group.append(rect, label);
    nextX += labelWidth + BRANCH_LABEL_GAP;
  }

  return nextX;
}

export function addLaneCommitRow({ svg, index, row, messageX, width }) {
  const state = graphStates[index];
  const { commit, lane, rowIndex } = row;
  const y = getLaneY(rowIndex);
  const branchColor = getLaneColor(index, row.branch, lane);
  const group = createSvgElement("g", {
    class: "commit-row" + (isWorkingTreeCommit(commit) ? " working-tree" : ""),
    transform: "translate(0, 0)",
    role: "button",
    tabindex: "0",
    "aria-label": "Show diff for " + commit.hash.substring(0, 12) + " " + commit.subject,
  });
  const hitbox = createSvgElement("rect", {
    class: "commit-row-hitbox",
    x: 0,
    y: y - COMMIT_ROW_HEIGHT / 2,
    width,
    height: COMMIT_ROW_HEIGHT,
    rx: 5,
  });
  const dot = createSvgElement("circle", {
    class: "commit-dot",
    cx: getLaneX(lane),
    cy: y,
    r: COMMIT_DOT_RADIUS,
    fill: branchColor,
  });
  const hash = createSvgElement("text", {
    class: "commit-hash",
    x: messageX,
    y,
  });
  const branchRefs = getCommitBranchRefs(commit);
  let subjectX = messageX + COMMIT_HASH_WIDTH + COMMIT_SUBJECT_GAP;
  const message = createSvgElement("text", {
    class: "commit-message",
    x: subjectX,
    y,
  });

  group.dataset.hash = commit.hash;
  hash.textContent = commit.hash.substring(0, 12);
  message.textContent = commit.subject;
  group.append(hitbox, dot, hash);

  if (branchRefs.length) {
    subjectX = addBranchLabels(group, index, commit, subjectX, y, lane) + COMMIT_SUBJECT_GAP;
    message.setAttribute("x", subjectX);
  }

  group.append(message);
  group.addEventListener("pointerover", () => group.classList.add("hover"));
  group.addEventListener("pointerout", (event) => {
    if (!group.contains(event.relatedTarget)) {
      group.classList.remove("hover");
    }
  });
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showDiff(state.graph, index, commit);
    }
  });
  group.addEventListener("click", (event) => {
    event.stopPropagation();
    showDiff(state.graph, index, commit);
  });
  group.addEventListener("contextmenu", (event) => showCommitContextMenu(event, index, commit));
  svg.append(group);
}

export function renderLaneGraph(index, commits) {
  const container = getGraphContainer(index);
  const rows = getLaneRows(index, commits);
  const maxLaneCount = rows.reduce((max, row) => Math.max(max, row.maxLaneCount), 1);
  const messageX = getLaneX(maxLaneCount) + LANE_MESSAGE_GAP;
  const height = rows.length ? getLaneY(rows.length - 1) + LANE_TOP : 1;
  const width = Math.max(container.clientWidth || 0, messageX + 720);
  const svg = createSvgElement("svg", {
    width,
    height,
    viewBox: "0 0 " + width + " " + height,
  });

  rows.forEach((row) => drawLaneContinuations(svg, index, row, rows.length));
  rows.forEach((row) => addLaneCommitRow({
    svg,
    index,
    row,
    messageX,
    width,
  }));

  container.replaceChildren(svg);
  updateCommitRowStates(index);
}

export function decorateCommitRows(index) {
  const state = graphStates[index];
  const container = getGraphContainer(index);
  const svg = container.querySelector("svg");
  const commits = state.commits.length ? state.commits : state.graph.commits || [];

  if (!svg || !commits.length) {
    return;
  }

  const width = getCommitRowsWidth(container, svg);

  for (const text of container.querySelectorAll("svg text")) {
    const messageGroup = text.parentElement;
    const firstMessageChild = messageGroup && messageGroup.firstElementChild;

    if (!messageGroup || firstMessageChild?.tagName.toLowerCase() === "rect") {
      continue;
    }

    const commit = getCommitForMessage(text, commits);
    const innerGroup = messageGroup.parentElement;
    const commitGroup = innerGroup && innerGroup.parentElement;

    if (!commit || !commitGroup) {
      continue;
    }

    const hitbox = ensureCommitRowHitbox(commitGroup, width);
    commitGroup.classList.add("commit-row");
    commitGroup.classList.toggle("working-tree", isWorkingTreeCommit(commit));
    commitGroup.dataset.hash = commit.hash;
    commitGroup.setAttribute("role", "button");
    commitGroup.setAttribute("tabindex", "0");
    commitGroup.setAttribute("aria-label", "Show diff for " + commit.hash.substring(0, 12) + " " + commit.subject);

    if (!commitGroup.dataset.commitRowDecorated) {
      commitGroup.dataset.commitRowDecorated = "true";
      commitGroup.addEventListener("pointerover", () => commitGroup.classList.add("hover"));
      commitGroup.addEventListener("pointerout", (event) => {
        if (!commitGroup.contains(event.relatedTarget)) {
          commitGroup.classList.remove("hover");
        }
      });
      commitGroup.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showDiff(state.graph, index, commit);
        }
      });
      hitbox.addEventListener("click", (event) => {
        event.stopPropagation();
        showDiff(state.graph, index, commit);
      });
      commitGroup.addEventListener("contextmenu", (event) => showCommitContextMenu(event, index, commit));
    }

    if (isCurrentCommit(commit)) {
      state.currentHash = commit.hash;
    }
  }

  updateCommitRowStates(index);
}

export function enhanceGraphRows(index) {
  centerBranchLabelsVertically(index);
  decorateCommitRows(index);
}

export function scheduleGraphEnhancements(index) {
  window.requestAnimationFrame(() => {
    enhanceGraphRows(index);
    window.requestAnimationFrame(() => enhanceGraphRows(index));
  });
  window.setTimeout(() => enhanceGraphRows(index), 80);
}

export function setGraphStatus(index, message, { error = false, canLoad = false } = {}) {
  const container = getGraphContainer(index);
  let status = container.querySelector(".graph-status");

  if (!status) {
    status = document.createElement("div");
    status.className = "graph-status";
    container.append(status);
  }

  status.classList.toggle("error", error);
  status.textContent = message;

  if (canLoad) {
    const button = document.createElement("button");
    button.className = "load-more";
    button.type = "button";
    button.textContent = "Load more";
    button.addEventListener("click", () => loadMoreCommits(index));
    status.append(" ", button);
  }
}

export function ensureLoadSentinel(index) {
  if (!INTERACTIVE.enabled) {
    return;
  }

  const container = getGraphContainer(index);
  let sentinel = container.querySelector(".load-sentinel");

  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.className = "load-sentinel";
    sentinel.dataset.index = String(index);
    uiState.loadObserver.observe(sentinel);
  }

  container.append(sentinel);
}

export function renderLoadedGraph(index) {
  const state = graphStates[index];

  if (!state.commits.length) {
    state.rendered = true;
    state.snapshotSignature = getStateSnapshotFingerprint(state);
    setGraphSummary(index);
    setGraphStatus(index, state.loading ? "Loading commits..." : "No commits found.");
    return;
  }

  state.currentHash = getCurrentCommitHash(state.commits) || state.currentHash;
  renderLaneGraph(index, pruneLoadedParents(state.commits));
  scheduleGraphEnhancements(index);
  state.rendered = true;
  state.snapshotSignature = getStateSnapshotFingerprint(state);
  setGraphSummary(index);
  ensureLoadSentinel(index);
  setGraphStatus(
    index,
    state.hasMore
      ? "Loaded " + state.commits.length + " commits. Scroll down to load more."
      : "Loaded all " + state.commits.length + " commits.",
    { canLoad: state.hasMore }
  );
}

export async function loadMoreCommits(index) {
  const state = graphStates[index];

  if (!INTERACTIVE.enabled || state.loading || !state.hasMore || state.graph.error) {
    return;
  }

  state.loading = true;
  setGraphStatus(index, "Loading commits...");

  try {
    const response = await fetch(
      "/api/graph/" + index + "/commits?offset=" + state.offset +
        "&limit=" + INTERACTIVE.pageSize +
        "&token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    state.commits = placeWorkingTreeCommits([...state.commits, ...result.commits]);
    state.graph.commits = state.commits;
    state.offset = result.nextOffset;
    state.hasMore = result.hasMore;
    state.workingTreeCount = result.workingTreeCount || state.workingTreeCount || 0;
    state.graph.workingTreeCount = state.workingTreeCount;
    state.graph.commitCount = state.commits.filter((commit) => !isWorkingTreeCommit(commit)).length;
    renderLoadedGraph(index);
  } catch (error) {
    setGraphStatus(index, error && error.message ? error.message : String(error), { error: true });
  } finally {
    state.loading = false;
  }
}
