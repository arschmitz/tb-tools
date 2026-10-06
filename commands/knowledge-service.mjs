import config from "../lib/config.mjs";
import { createKnowledgeService, knowledgeOptions } from "./knowledge/service.mjs";
import { knowledgeDirectory } from "./knowledge/instructions.mjs";
import { generateKnowledge } from "./knowledge/generate.mjs";

let defaultService;
export const consoleKnowledgeRepository = () => knowledgeOptions(config).repositoryDirectory;
export const consoleKnowledgeDirectory = (_settings, home) => knowledgeDirectory(config, home);

export async function generateConsoleKnowledge(prompt, options) {
  const { resolveGraphCodexCommand } = await import("./graph/patch-update.mjs");
  const command = await resolveGraphCodexCommand({ configuredCommand: options.command });
  return generateKnowledge(prompt, { ...options, command });
}

export async function getDefaultKnowledgeService() {
  if (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis) return null;
  if (!defaultService) {
    defaultService = (async () => {
      const options = knowledgeOptions(config);
      if (!options.enabled) return null;
      return (await createKnowledgeService(options, { generate: generateConsoleKnowledge })).initialize();
    })().catch(error => { console.warn(`Knowledge unavailable: ${error.message}`); return null; });
  }
  return defaultService;
}

export async function stopDefaultKnowledgeService() {
  const current = defaultService; defaultService = null;
  await (await current)?.close();
}
