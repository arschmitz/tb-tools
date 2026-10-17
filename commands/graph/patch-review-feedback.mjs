import { createHash } from "node:crypto";

export function rememberReviewFinding(session, issue) {
  if (!issue.originalSuggestion) {
    if (["pending", "posted"].includes(issue.state)) {
      issue.originalUnavailable = true;
      issue.findingKey ||= createHash("sha256").update(JSON.stringify([
        session.rawPatchHash, issue.id, issue.filePath, issue.lineNumber,
      ])).digest("hex");
      return issue;
    }
    issue.originalSuggestion = {
      comment: issue.suggestedComment || "", code: issue.codeSuggestion || "",
      hasCode: Boolean(issue.codeSuggestion || issue.isDeletion),
      filePath: issue.filePath, lineNumber: issue.lineNumber, lineLength: issue.lineLength || 1,
      patchHash: session.rawPatchHash || session.currentHash || "",
    };
  }
  issue.findingKey ||= createHash("sha256").update(JSON.stringify(issue.originalSuggestion)).digest("hex");
  return issue;
}

export function rateGraphPatchReviewFinding({ session, itemId, rating, reason = "" }) {
  if (!["up", "down", ""].includes(rating) || typeof reason !== "string" || reason.length > 2000) {
    throw Object.assign(new Error("Choose thumbs up, thumbs down, or clear feedback. Keep the reason under 2,000 characters."), { statusCode: 400 });
  }
  const issue = session.issues?.find(item => item.id === String(itemId));
  if (!issue) throw Object.assign(new Error("That review finding is no longer available."), { statusCode: 404 });
  rememberReviewFinding(session, issue);
  issue.feedback = { rating, reason: reason.trim(), at: new Date().toISOString() };
  session.findingFeedbackHistory ||= [];
  session.findingFeedbackHistory.push({ findingKey: issue.findingKey, originalSuggestion: issue.originalSuggestion,
    ...issue.feedback });
  return issue;
}

export function rememberReviewDraft(session, issue, { comment, code, kind, receipt }) {
  rememberReviewFinding(session, issue);
  issue.savedDraft = { comment, code: kind === "suggestion" ? code : "", hasCode: kind === "suggestion",
    at: new Date().toISOString(), inlineId: receipt?.inlineId || receipt?.id || "" };
}

export function rememberPostedReviewDraft(issue) {
  // Old saved sessions did not retain the exact submitted draft.
  if (issue.savedDraft) issue.postedDraft = { ...issue.savedDraft, postedAt: new Date().toISOString() };
}
