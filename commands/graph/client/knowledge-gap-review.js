const dimensions = { correctness: "Correctness", completeness: "Completeness", citationSupport: "Source support", scope: "Scope", uncertainty: "Uncertainty" };

export function renderGapEvaluations(reports, { drafts }) {
  const container = document.createElement("div"); container.className = "knowledge-gap-evaluations";
  for (const report of reports) {
    const details = document.createElement("details");
    const saved = drafts.get(report.key) || {};
    details.open = Boolean(saved.open);
    details.addEventListener("toggle", () => {
      if (details.isConnected) drafts.set(report.key, { ...(drafts.get(report.key) || {}), open: details.open });
    });
    const summary = document.createElement("summary");
    summary.textContent = report.answer ? `Answer evaluation: ${report.question.slice(0, 160)}` : `Retrieval check: ${report.question.slice(0, 160)}`;
    details.append(summary);
    const state = document.createElement("p");
    const answerReview = report.answerReview || report.humanReview;
    state.textContent = answerReview ? `Answer review: ${report.answerQuality}. ${answerReview.rationale}`
      : report.error || (report.answer ? "Automatic source review waits for available model-call budget."
        : report.retrieval?.pass ? "The checked source excerpts were found. Answer generation has not completed."
          : "The query still misses required evidence.");
    details.append(state);
    if (report.case) {
      const label = document.createElement("h4"); label.textContent = "Checked source evidence"; details.append(label);
      for (const anchor of report.case.anchors) {
        const source = document.createElement("p"); source.textContent = `${anchor.path} at ${anchor.revision.slice(0, 12)}`;
        const excerpt = document.createElement("pre"); excerpt.textContent = anchor.contains.join("\n");
        details.append(source, excerpt);
      }
    }
    if (report.answer) {
      const label = document.createElement("h4"); label.textContent = "Generated answer";
      const answer = document.createElement("p"); answer.style.whiteSpace = "pre-wrap"; answer.textContent = report.answer;
      details.append(label, answer);
      if (answerReview) {
        const heading = document.createElement("h4"); heading.textContent = "Source review";
        const scores = document.createElement("dl");
        for (const [key, title] of Object.entries(dimensions)) {
          const name = document.createElement("dt"); name.textContent = title;
          const score = document.createElement("dd"); score.textContent = `${answerReview.scores[key]}/2`;
          scores.append(name, score);
        }
        const facts = document.createElement("ul");
        for (const fact of answerReview.facts) {
          const row = document.createElement("li");
          row.textContent = `${report.case.facts[fact.index]} ${fact.verdict}: ${fact.reason}`;
          facts.append(row);
        }
        details.append(heading, scores, facts);
      }
    }
    container.append(details);
  }
  return container;
}
