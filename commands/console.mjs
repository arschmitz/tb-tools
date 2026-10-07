import defaultConfig from "../lib/config.mjs";
import { createGraphCommand } from "./graph.mjs";

export function createConsoleCommand(options = {}) {
  return createGraphCommand({
    ...options,
    appConfig: { ...defaultConfig, ...options.appConfig, taskWorktrees: true },
    forceInteractive: true,
  });
}

export default createConsoleCommand();
