import { saveAiContext } from "./ai-context.mjs";
import { getDefaultKnowledgeService } from "../knowledge-service.mjs";

export async function prepareAiRepositoryContext({ cwd, runCommand, directory }) {
  const git = async args => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true }));
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const [status, commit, files, diff] = await Promise.all([
    git(["status", "--porcelain=v1"]), git(["show", "-s", "--format=%H%n%P%n%B", head]),
    git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", head]),
    git(["show", "--format=", "--no-ext-diff", head]),
  ]);
  try {
    await (await getDefaultKnowledgeService())?.captureSource({ cwd, title: "Commit and patch read for an AI task",
      text: `${commit}\n${diff}`, revision: head,
      paths: files.trim().split("\n").map(line => line.split("\t").at(-1)).filter(Boolean), type: "commit" });
  } catch { /* Preserve the original task when optional knowledge capture fails. */ }
  return { cwd, head, status: status.trim(), commit: commit.trim(), files: files.trim(),
    diffFile: await saveAiContext({ head, diff }, { directory }) };
}
