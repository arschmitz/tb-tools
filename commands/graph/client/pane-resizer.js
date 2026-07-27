import {
  PANE_MIN_WIDTH,
  PANE_RESIZE_KEY_STEP,
  PANE_WIDTH_STORAGE_PREFIX,
  graphStates,
  uiState,
} from "./config.js";
import { getGraphContainer, getWorkspace } from "./dom.js";
import { enhanceGraphRows } from "./lane-renderer.js";

export function getPaneStorageKey(index) {
  const graph = graphStates[index].graph;

  return PANE_WIDTH_STORAGE_PREFIX + graph.label + ":" + graph.path;
}

export function getPaneWidthLimits(workspace) {
  const resizer = workspace.querySelector(".pane-resizer");
  const totalWidth = Math.max(
    0,
    workspace.getBoundingClientRect().width - (resizer ? resizer.getBoundingClientRect().width : 0)
  );
  const minWidth = Math.min(PANE_MIN_WIDTH, Math.floor(totalWidth / 2));

  return {
    min: minWidth,
    max: Math.max(minWidth, totalWidth - minWidth),
    total: totalWidth,
  };
}

export function updatePaneResizerValue(index, width, totalWidth) {
  const resizer = getWorkspace(index)?.querySelector(".pane-resizer");

  if (!resizer || !totalWidth) {
    return;
  }

  const percent = Math.round((width / totalWidth) * 100);
  resizer.setAttribute("aria-valuenow", String(percent));
  resizer.setAttribute("aria-valuetext", percent + "% graph pane width");
}

export function schedulePaneEnhancement(index) {
  if (uiState.pendingPaneEnhancements.has(index)) {
    return;
  }

  uiState.pendingPaneEnhancements.add(index);
  window.requestAnimationFrame(() => {
    uiState.pendingPaneEnhancements.delete(index);
    enhanceGraphRows(index);
  });
}

export function setGraphPaneWidth(index, width, { persist = true } = {}) {
  const workspace = getWorkspace(index);

  if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  const limits = getPaneWidthLimits(workspace);
  const clampedWidth = Math.min(limits.max, Math.max(limits.min, width));

  workspace.style.setProperty("--graph-pane-width", clampedWidth + "px");
  updatePaneResizerValue(index, clampedWidth, limits.total);
  schedulePaneEnhancement(index);

  if (!persist) {
    return;
  }

  try {
    localStorage.setItem(getPaneStorageKey(index), String(Math.round(clampedWidth)));
  } catch {
    // Private browsing or file restrictions can make storage unavailable.
  }
}

export function restoreGraphPaneWidth(index) {
  const workspace = getWorkspace(index);

  if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  try {
    const storedWidth = Number(localStorage.getItem(getPaneStorageKey(index)));

    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setGraphPaneWidth(index, storedWidth, { persist: false });
      return;
    }
  } catch {
    // Keep the default CSS split if storage is unavailable.
  }

  const graphPane = workspace.querySelector(".graph");
  const limits = getPaneWidthLimits(workspace);

  updatePaneResizerValue(index, graphPane.getBoundingClientRect().width, limits.total);
}

export function startPaneResize(event) {
  if (event.button !== 0 || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  event.preventDefault();

  const resizer = event.currentTarget;
  const index = Number(resizer.dataset.index);
  const graphPane = getGraphContainer(index);
  const startX = event.clientX;
  const startWidth = graphPane.getBoundingClientRect().width;
  const pointerId = event.pointerId;

  resizer.classList.add("dragging");
  document.body.classList.add("is-resizing-panes");
  resizer.setPointerCapture(pointerId);

  const handlePointerMove = (moveEvent) => {
    setGraphPaneWidth(index, startWidth + moveEvent.clientX - startX);
  };
  const stopResize = () => {
    resizer.classList.remove("dragging");
    document.body.classList.remove("is-resizing-panes");
    resizer.removeEventListener("pointermove", handlePointerMove);
    resizer.removeEventListener("pointerup", stopResize);
    resizer.removeEventListener("pointercancel", stopResize);

    if (resizer.hasPointerCapture(pointerId)) {
      resizer.releasePointerCapture(pointerId);
    }
  };

  resizer.addEventListener("pointermove", handlePointerMove);
  resizer.addEventListener("pointerup", stopResize);
  resizer.addEventListener("pointercancel", stopResize);
}

export function resizePaneFromKeyboard(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  const index = Number(event.currentTarget.dataset.index);
  const workspace = getWorkspace(index);

  if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  event.preventDefault();

  const limits = getPaneWidthLimits(workspace);
  const currentWidth = getGraphContainer(index).getBoundingClientRect().width;
  const step = event.shiftKey ? PANE_RESIZE_KEY_STEP * 4 : PANE_RESIZE_KEY_STEP;

  if (event.key === "Home") {
    setGraphPaneWidth(index, limits.min);
  } else if (event.key === "End") {
    setGraphPaneWidth(index, limits.max);
  } else {
    setGraphPaneWidth(index, currentWidth + (event.key === "ArrowRight" ? step : -step));
  }
}
