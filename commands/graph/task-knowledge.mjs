import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeKnowledgeRequest } from "../knowledge/task-query.mjs";

const execute = promisify(execFile);
const questionText = values => [...new Set(values.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))].join("\n\n");
const repositoryPaths = repository => String(repository?.files || "").split("\n").map(line => line.split("\t").at(-1)).filter(Boolean);

export function implementationKnowledgeRequest(state, role, repository) {
  const findings = (state.reports || []).filter(entry => entry.role === "verify").at(-1)?.report?.findings || [];
  return normalizeKnowledgeRequest({
    question: questionText([
      ...(state.instructions || []).slice().reverse().map(item => item.text),
      `Bug ${state.bugId}: ${state.bug?.summary || ""}`,
      ...findings.map(item => item.description),
      state.comments?.[0]?.text,
    ]),
    taskType: role === "verify" ? "verify" : "implement",
    // A new bug does not inherit the paths changed by its base commit.
    paths: state.commitHash ? repositoryPaths(repository) : [],
    revision: repository?.head || state.commitHash || state.baseHash,
  });
}

export async function patchKnowledgeRequest(session, { question, item, taskType } = {}) {
  let paths = [];
  if (/^[a-f0-9]{40}$/i.test(session.currentHash || "") && session.graph?.path) {
    try {
      const result = await execute("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", session.currentHash],
        { cwd: session.graph.path, timeout: 3000, maxBuffer: 100_000 });
      paths = result.stdout.split("\0").filter(Boolean);
    } catch { /* The task can retrieve by question when its patch paths are unavailable. */ }
  }
  const items = item ? [item] : session.items || [];
  return normalizeKnowledgeRequest({
    question: questionText([
      question,
      ...items.map(value => value.instruction),
      session.commitMessage,
      ...items.map(value => value.content),
      session.patchContext?.purpose,
      session.revision,
    ]),
    taskType: taskType || (session.status === "applying" || session.mode === "freeform" ? "edit" : session.mode === "verify" ? "verify" : "review"),
    paths: [...items.map(value => value.filePath).filter(Boolean), ...paths],
    revision: session.currentHash,
  });
}

export function tryKnowledgeRequest(state, writable, repository, evidence = state.evidence) {
  return normalizeKnowledgeRequest({
    question: questionText([
      `${writable ? "Repair" : "Diagnose"} Try failures for ${state.subject || "the patch"}`,
      ...(state.assessment?.failures || []).map(failure => failure.reason),
      ...(evidence?.failures || []).map(failure => failure.job || failure.name),
    ]),
    taskType: writable ? "repair" : "diagnosis",
    paths: repositoryPaths(repository),
    revision: repository?.head || state.validationHash || state.fixupHash || state.sourceHash,
  });
}
