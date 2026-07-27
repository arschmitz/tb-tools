import { graphStates } from "./config.js";

export function showError(container, message) {
  const error = document.createElement("pre");
  error.className = "error";
  error.textContent = message;
  container.replaceChildren(error);
}

export function getGraphContainer(index) {
  return document.getElementById("graph-" + index);
}

export function setGraphSummary(index) {
  const state = graphStates[index];
  const summary = document.querySelector('.summary[data-index="' + index + '"]');

  if (!summary) {
    return;
  }

  summary.querySelector(".summary-path").textContent = state.graph.path || "";
  summary.querySelector(".summary-branch").textContent = state.graph.branch || "";
  summary.querySelector(".summary-count").textContent = (state.graph.commitCount || 0) + " commit(s)";

  const workingTree = summary.querySelector(".summary-working-tree");
  const count = state.workingTreeCount || 0;
  workingTree.hidden = !count;
  workingTree.textContent = count + " uncommitted change set" + (count === 1 ? "" : "s");
}

export function getWorkspace(index) {
  return document.querySelector('.workspace[data-index="' + index + '"]');
}

