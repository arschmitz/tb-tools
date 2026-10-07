import { INTERACTIVE } from "./config.js";

function renderButton(button, handled) {
  button.dataset.handled = String(handled);
  button.setAttribute("aria-pressed", String(handled));
  button.textContent = handled ? "✓ Handled" : "Mark handled";
  button.title = handled ? "Return this patch to the review queue" : "Remove this patch from your review queue";
  button.setAttribute("aria-label", `${handled ? "Handled; undo for" : "Mark handled:"} ${button.dataset.revision}`);
}

export function createReviewHandledButton(patch, { load = false, onError = () => {} } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-handled-toggle";
  button.dataset.revision = patch.id;
  renderButton(button, Boolean(patch.handled));
  if (load) {
    button.disabled = true;
    fetch(`/api/dashboard/review-handled?token=${encodeURIComponent(INTERACTIVE.token)}`, { cache: "no-store" })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Could not load handled reviews.");
        renderButton(button, result.handledReviews.some(item => item.id === patch.id));
        button.disabled = false;
      }).catch(error => onError(error));
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch("/api/dashboard/review-handled", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token, revision: patch.id,
          handled: button.dataset.handled !== "true", title: patch.title }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not save handled review.");
      window.dispatchEvent(new CustomEvent("review-handled-changed", { detail: result.handledReviews }));
    } catch (error) { onError(error); }
    finally { button.disabled = false; }
  });
  return button;
}

window.addEventListener("review-handled-changed", event => {
  const handled = new Set(event.detail.map(patch => patch.id));
  for (const button of document.querySelectorAll(".review-handled-toggle")) {
    renderButton(button, handled.has(button.dataset.revision));
  }
});
