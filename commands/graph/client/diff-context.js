const CONTEXT_LINES_TO_EXPAND = 20;

function getDiffContextActionLabel(button, hiddenLineCount) {
  const lineLabel = hiddenLineCount === 1 ? "line" : "lines";
  const position = button.dataset.contextPosition;
  const positionLabel = position === "top"
    ? " above"
    : position === "bottom"
      ? " below"
      : "";
  const count = button.dataset.expandMode === "all"
    ? hiddenLineCount
    : Math.min(hiddenLineCount, CONTEXT_LINES_TO_EXPAND);
  const verb = button.dataset.expandMode === "all" ? "Show all" : "Expand";

  return `${verb} ${count} ${lineLabel}${positionLabel}`;
}

function updateDiffContextExpander(expander, hiddenLineCount) {
  expander.querySelectorAll(".diff-context-expander-button").forEach((button) => {
    button.textContent = getDiffContextActionLabel(button, hiddenLineCount);

    if (button.dataset.expandMode === "all") {
      button.hidden = hiddenLineCount <= CONTEXT_LINES_TO_EXPAND;
    }
  });
}

export function expandDiffContext(button) {
  const contextGroup = button.dataset.contextGroup;
  const body = button.closest("tbody");
  const expander = button.closest(".diff-context-expander");

  if (!contextGroup || !body || !expander) {
    return;
  }

  const collapsedRows = Array.from(body.querySelectorAll(".collapsed-context"))
    .filter((row) => row.dataset.contextGroup === contextGroup);
  const shouldExpandAll = button.dataset.expandMode === "all";
  const rowsToExpand = shouldExpandAll
    ? collapsedRows
    : expander.dataset.contextDirection === "end"
      ? collapsedRows.slice(-CONTEXT_LINES_TO_EXPAND)
      : collapsedRows.slice(0, CONTEXT_LINES_TO_EXPAND);

  rowsToExpand.forEach((row) => {
    row.hidden = false;
    row.classList.remove("collapsed-context");
  });

  const remainingRows = collapsedRows.length - rowsToExpand.length;
  if (!remainingRows) {
    button.setAttribute("aria-expanded", "true");
    expander.remove();
    return;
  }

  const lastExpandedRow = rowsToExpand[rowsToExpand.length - 1];
  lastExpandedRow?.after(expander);
  updateDiffContextExpander(expander, remainingRows);
}

export function handleDiffContextClick(event) {
  const button = event.target.closest(".diff-context-expander-button");

  if (!button) {
    return false;
  }

  expandDiffContext(button);
  return true;
}
