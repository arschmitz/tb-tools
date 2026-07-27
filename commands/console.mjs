import { createGraphCommand } from "./graph.mjs";

export function createConsoleCommand(options = {}) {
  return createGraphCommand({
    ...options,
    forceInteractive: true,
  });
}

export default createConsoleCommand();
