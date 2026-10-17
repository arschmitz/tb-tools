import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDifferentialIdentity, getLegacyToolsId, resolvePatchIdentity, savePatchIdentityAlias } from "./patch-identity.mjs";
import { ensureTbToolsIdInCommitMessage } from "./commit-message.mjs";

export async function finishSubmittedPatchIdentity({ beforeMessage = "", message, runCommand }) {
  const revision = getDifferentialIdentity(message);
  if (!revision) return;
  const legacy = getLegacyToolsId(message) || getLegacyToolsId(beforeMessage);
  // A copied patch can retain an ID already assigned to an older revision.
  // The submitted message identifies this patch; keep the old alias intact.
  if (legacy && [legacy, revision].includes(resolvePatchIdentity(legacy))) {
    try { savePatchIdentityAlias(legacy, revision); }
    catch (error) { if (error.code !== "PATCH_IDENTITY_CONFLICT") throw error; }
  }
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
