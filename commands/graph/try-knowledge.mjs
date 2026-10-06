import { getDefaultKnowledgeService } from "../knowledge-service.mjs";
import { repositoryContext } from "../knowledge/service.mjs";

// Store matching signatures as observations, not automatic pass decisions.
export async function rememberTrySignatures(state, groups, knowledge) {
  knowledge ??= await getDefaultKnowledgeService();
  if (!knowledge) return 0;
  const context = knowledge.store ? await repositoryContext(state.path) : undefined;
  let count = 0;
  for (const group of groups) {
    if (!group.matchCount || !group.match || group.signature.length > 12000) continue;
    await knowledge.captureSource({ context, cwd: state.path, type: "ci-signature",
      revision: state.attempts.at(-1)?.hash || state.fixupHash || state.sourceHash,
      title: "CI failure signature observed on another push",
      text: JSON.stringify({ signature: group.signature, targetJobs: group.jobs,
        targetRun: state.attempts.at(-1)?.url, matchingPush: group.match,
        matchCount: group.matchCount, fullMatchesFile: group.matchesFile,
        applicability: "This exact signature occurred on another push. Check current evidence, independence of that push, and every other failure before assigning a verdict. This observation alone does not establish that an entire Try passed." }),
    });
    count++;
  }
  return count;
}


export async function rememberCiPushes(state, pushes, knowledge, context) {
  knowledge ??= await getDefaultKnowledgeService();
  if (!knowledge) return 0;
  context ||= await repositoryContext(state.path);
  let count = 0;
  for (const push of pushes) {
    if (!push.observations?.length) continue;
    const unique = new Map();
    for (const observation of push.observations) {
      if (!unique.has(observation.signature)) unique.set(observation.signature, observation);
    }
    const examples = [];
    let characters = 0;
    for (const observation of unique.values()) {
      const length = JSON.stringify(observation).length;
      if (examples.length >= 12 || characters + length > 16000) break;
      examples.push(observation); characters += length;
    }
    await knowledge.captureSource({ context, cwd: state.path, type: "ci-push-summary",
      revision: push.revision, title: `${push.repo}: observed CI failures`,
      text: JSON.stringify({ repository: push.repo, revision: push.revision,
        author: push.author, signatureCount: unique.size, examples,
        fullEvidenceFile: push.evidenceFile || push.observations[0]?.evidenceFile,
        applicability: "Historical CI observations, including main-branch and other authors' pushes. Examples are a bounded index, not the full error list. Read the full evidence for exact matching and check every current failure. These records do not establish a pass or patch causality." }),
    });
    count++;
  }
  return count;
}
