import { formatWorkspaceStatus, getWorkspaceContext } from "../lib/workflow.mjs";

export function createStatusCommand({
  getContext = getWorkspaceContext,
  write = console.log,
} = {}) {
  return async function status(options = {}) {
    write(formatWorkspaceStatus(await getContext(options)));
  };
}

export default createStatusCommand();
