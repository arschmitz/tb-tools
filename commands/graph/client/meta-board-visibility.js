export function isClosedBoardBug(card) {
  const resolution = String(card.resolution || "").trim();

  return card.isOpen === false ||
    /^(resolved|verified|closed)$/i.test(String(card.status || "").trim()) ||
    Boolean(resolution && resolution !== "---");
}

export function isAbandonedBoardPatch(patch) {
  return /abandon/i.test(`${patch.status || ""} ${patch.statusName || ""}`);
}
