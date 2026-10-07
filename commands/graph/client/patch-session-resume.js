import { showSystemChoice } from "./system-dialog.js";

export async function startOrResumePatchSession(url, body) {
  const send = async (payload) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Could not open the patch session.");
    return result;
  };
  const result = await send(body);
  if (!result.resumeAvailable) return result;
  const choice = await showSystemChoice({
    title: `Resume ${result.revision}?`,
    message: url === "/api/review"
      ? "Resume the saved review conversation and check for new comments. If the checkout or patch changed, pull the requested revision into the Review checkout again and re-evaluate the findings. This replaces local Review experiment changes. Start a new run for a new conversation."
      : body.mode === "verify"
        ? "Resume the saved Verify findings and Codex conversation. If a newer local copy exists, Verify checks it out in the working checkout and reviews it again. Start a new run for a new conversation."
      : "Resume the saved output, comments, and Codex conversation. If the checkout changed, Review Update refreshes the local patch and reviewer comments, then re-evaluates them in the saved conversation. Start a new run to discard the saved results.",
    choices: [
      { value: "resume", label: "Resume saved session" },
      { value: "new", label: "Start new run" },
    ],
  });
  if (!["resume", "new"].includes(choice)) return null;
  return send({ ...body, resume: choice === "resume" });
}
