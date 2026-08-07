export function expandDiffContext(button) {
  const contextGroup = button.dataset.contextGroup;
  const body = button.closest("tbody");

  if (!contextGroup || !body) {
    return;
  }

  body.querySelectorAll(".collapsed-context").forEach((row) => {
    if (row.dataset.contextGroup === contextGroup) {
      row.hidden = false;
      row.classList.remove("collapsed-context");
    }
  });
  button.setAttribute("aria-expanded", "true");
  button.closest(".diff-context-expander")?.remove();
}

export function handleDiffContextClick(event) {
  const button = event.target.closest(".diff-context-expander-button");

  if (!button) {
    return false;
  }

  expandDiffContext(button);
  return true;
}
