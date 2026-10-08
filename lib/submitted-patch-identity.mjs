import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDifferentialIdentity, getLegacyToolsId, savePatchIdentityAlias } from "./patch-identity.mjs";
import { ensureTbToolsIdInCommitMessage } from "./commit-message.mjs";

export async function finishSubmittedPatchIdentity({ beforeMessage = "", message, runCommand }) {
  const revision = getDifferentialIdentity(message);
  if (!revision) return;
  const legacy = getLegacyToolsId(message) || getLegacyToolsId(beforeMessage);
  if (legacy) savePatchIdentityAlias(legacy, revision);
  const clean = ensureTbToolsIdInCommitMessage(message).message;
  if (clean === message.trimEnd()) return;
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-submitted-identity-"));
  try {
    const file = path.join(directory, "message");
    await writeFile(file, `${clean}\n`);
    // Only change the message. Staged edits must remain outside this commit.
    await runCommand({ cmd: "git", args: ["commit", "--amend", "--only", "--no-verify", "-F", file], capture: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
