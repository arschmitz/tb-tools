import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const TB_TOOLS_ID_TRAILER = "TB-Tools-Id";
const TB_TOOLS_HOOK_BEGIN = "# tb-tools commit-msg hook begin";
const TB_TOOLS_HOOK_END = "# tb-tools commit-msg hook end";

const TB_TOOLS_ID_PATTERN = new RegExp(
  `(?:^|\\n)${TB_TOOLS_ID_TRAILER}:\\s*([^\\s]+)\\s*(?=\\n|$)`,
  "i",
);

export function getTbToolsIdFromCommitMessage(message = "") {
  return String(message || "").match(TB_TOOLS_ID_PATTERN)?.[1] || "";
}

export function ensureTbToolsIdInCommitMessage(message = "", id = randomUUID()) {
  const normalizedMessage = String(message || "").replace(/\r\n/g, "\n").trimEnd();
  const existingId = getTbToolsIdFromCommitMessage(normalizedMessage);

  if (existingId) {
    return {
      id: existingId,
      message: normalizedMessage,
      added: false,
    };
  }

  return {
    id,
    message: `${normalizedMessage}\n\n${TB_TOOLS_ID_TRAILER}: ${id}`,
    added: true,
  };
}

function getTbToolsCommitMsgHook() {
  return `${TB_TOOLS_HOOK_BEGIN}
if command -v node >/dev/null 2>&1; then
node - "$1" <<'TB_TOOLS_COMMIT_MSG' || true
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const messagePath = process.argv[2];
const trailer = "${TB_TOOLS_ID_TRAILER}";
const message = fs.readFileSync(messagePath, "utf8").replace(/\\r\\n/g, "\\n").trimEnd();
const pattern = new RegExp("(?:^|\\\\n)" + trailer + ":\\\\s*[^\\\\s]+\\\\s*(?=\\\\n|$)", "i");
const hasCommitText = message
  .split("\\n")
  .some((line) => line.trim() && !line.trim().startsWith("#"));

if (hasCommitText && !pattern.test(message)) {
  fs.writeFileSync(messagePath, message + "\\n\\n" + trailer + ": " + randomUUID() + "\\n");
}
TB_TOOLS_COMMIT_MSG
fi
${TB_TOOLS_HOOK_END}`;
}

export async function installTbToolsCommitMsgHook({
  cwd = process.cwd(),
  runCommand,
} = {}) {
  if (!runCommand) {
    return false;
  }

  const output = await runCommand({
    cmd: "git",
    args: ["rev-parse", "--git-path", "hooks/commit-msg"],
    cwd,
    capture: true,
    silent: true,
  });
  const hookPath = output.trim();
  const absoluteHookPath = path.isAbsolute(hookPath)
    ? hookPath
    : path.join(cwd, hookPath || ".git/hooks/commit-msg");
  const hookBlock = getTbToolsCommitMsgHook();
  let content = "";

  try {
    content = await readFile(absoluteHookPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (content.includes(TB_TOOLS_HOOK_BEGIN)) {
    return false;
  }

  const trimmedContent = content.trimEnd();
  let nextContent;

  if (!trimmedContent) {
    nextContent = `#!/bin/sh\n\n${hookBlock}\n`;
  } else if (trimmedContent.startsWith("#!")) {
    const firstLineEnd = trimmedContent.indexOf("\n");

    if (firstLineEnd === -1) {
      nextContent = `${trimmedContent}\n\n${hookBlock}\n`;
    } else {
      nextContent = `${trimmedContent.slice(0, firstLineEnd)}\n\n${hookBlock}\n\n${trimmedContent.slice(firstLineEnd + 1)}\n`;
    }
  } else {
    nextContent = `#!/bin/sh\n\n${hookBlock}\n\n${trimmedContent}\n`;
  }

  await mkdir(path.dirname(absoluteHookPath), { recursive: true });
  await writeFile(absoluteHookPath, nextContent);
  await chmod(absoluteHookPath, 0o755);

  return true;
}
