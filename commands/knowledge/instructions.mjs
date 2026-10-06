import os from "node:os";
import path from "node:path";

export function knowledgeDirectory(settings = {}, home = os.homedir()) {
  const value = settings.ai?.knowledge?.directory || "~/.tb-tools/knowledge";
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value);
}

export function knowledgeInstructions(directory = knowledgeDirectory(), repositoryDirectory = "") {
  const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
  return `# Console knowledge instructions

${repositoryDirectory ? `Shared memory repository: ${repositoryDirectory}. Read its AGENTS.md for retrieval, evidence, contribution, and merge rules. Its notes and records are the shared knowledge. You can read and update them with normal file and Git tools; no separate application is required.` : "Shared memory checkout is not configured."}

Local search and private evidence directory: ${directory}.
Do not write console knowledge to ~/.codex/memories. Legacy imports only read it.
Use relevant supplied knowledge before generation or review. Search by component,
path, symbol, bug, or review ID. Open only useful evidence; do not load the entire
library. Optional console commands:

    tb knowledge search --directory ${quoted} --repository thunderbird 'path symbol'
    tb knowledge show --directory ${quoted} RECORD_ID

Use repository tb-tools for console work. Current instructions and verified source
outweigh historical claims. Check scope, revision, outcome, and validation limits.
Recent timestamps alone do not establish style rules or settle conflicting claims.

The console automatically captures requests, final answers, completed tool events,
source snapshots, and review outcomes. State useful lessons with exact references
and uncertainty. Background extraction creates cited lessons within a daily budget.
Do not claim that planned, applied, or reviewed work passed tests unless it did.

Outside console tasks, follow the shared repository AGENTS.md to add a unique
Markdown note with evidence and scope. Do not overwrite existing notes or records.
Use a new correction referencing the old note. Keep raw personal transcripts and
restricted evidence local. Generated indexes, models, and private history do not
belong in the shared repository. Git hosting permissions control who can push.
Do not force-push. Fetch and merge unique new files; report unresolved instruction
or evidence conflicts. The console automates local commits and sync when configured.
If memory is unavailable, continue with current source and report the limit.
`;
}

// These overrides apply only to the console's child process.
export const CODEX_MEMORY_ARGS = ["-c", "memories.generate_memories=false", "-c", "memories.use_memories=false"];
