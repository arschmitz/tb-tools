// Scroll once when the current input changes or its diff is rebuilt.
// Polling the same state must not pull the user away from manual inspection.
export function createReviewAttentionScroller() {
  let previousKey = "";
  let previousTarget = null;
  let frame = 0;

  return (key, target, enabled = true) => {
    if (!enabled || !target) {
      window.cancelAnimationFrame(frame);
      previousKey = "";
      previousTarget = null;
      return;
    }
    if (key === previousKey && target === previousTarget) return;
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      if (!target.isConnected || !target.getClientRects().length) return;
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      previousKey = key;
      previousTarget = target;
    });
  };
}
