import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_FILE_NAME = "patch-update-handled-comments.json";

export function getGraphPatchUpdateStatePath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".tb-tools", STATE_FILE_NAME);
}

function getRevisionKey(revision = "") {
  const match = String(revision).trim().match(/^D?(\d+)$/i);

  return match ? `D${match[1]}` : "";
}

async function readGraphPatchUpdateState({ readStateFile, statePath }) {
  try {
    const state = JSON.parse(await readStateFile(statePath, "utf8"));

    return state && typeof state === "object" ? state : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw new Error(`Could not read patch update state: ${error?.message || error}`);
  }
}

export async function getGraphPatchUpdateHandledCommentIds({
  readStateFile = readFile,
  revision,
  statePath = getGraphPatchUpdateStatePath(),
} = {}) {
  const revisionKey = getRevisionKey(revision);

  if (!revisionKey) {
    return new Set();
  }

  const state = await readGraphPatchUpdateState({ readStateFile, statePath });
  const commentIds = state.revisions?.[revisionKey]?.handledCommentIds;

  return new Set(Array.isArray(commentIds) ? commentIds.map(String) : []);
}

export async function markGraphPatchUpdateCommentHandled({
  createDirectory = mkdir,
  now = new Date(),
  readStateFile = readFile,
  renameFile = rename,
  revision,
  statePath = getGraphPatchUpdateStatePath(),
  writeStateFile = writeFile,
  itemId,
} = {}) {
  const revisionKey = getRevisionKey(revision);
  const commentId = String(itemId || "").trim();

  if (!revisionKey || !commentId) {
    const error = new Error("A revision and review comment are required to persist handled state.");

    error.statusCode = 400;
    throw error;
  }

  const state = await readGraphPatchUpdateState({ readStateFile, statePath });
  const current = state.revisions?.[revisionKey]?.handledCommentIds || [];
  const handledCommentIds = Array.from(new Set([...current.map(String), commentId]));

  state.revisions ||= {};
  state.revisions[revisionKey] = {
    handledCommentIds,
    updatedAt: now.toISOString(),
  };

  await createDirectory(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;

  await writeStateFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await renameFile(temporaryPath, statePath);
  return new Set(handledCommentIds);
}
