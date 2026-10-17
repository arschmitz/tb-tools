import config from "../lib/config.mjs";
import { createKnowledgeService, knowledgeOptions } from "./knowledge/service.mjs";
import { knowledgeDirectory } from "./knowledge/instructions.mjs";
import { generateKnowledge } from "./knowledge/generate.mjs";

let defaultService, resolvedService, initializationError;
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
      const service = await createKnowledgeService(options, { generate: generateConsoleKnowledge });
      await service.initialize();
      resolvedService = service;
      return service;
    })().catch(error => { initializationError = error.message; console.warn(`Knowledge unavailable: ${error.message}`); return null; });
  }
  return defaultService;
}

export function getDefaultKnowledgeSnapshot() {
  if (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis) return null;
  if (resolvedService) return resolvedService.queryGapStatus();
  if (!knowledgeOptions(config).enabled) return null;
  return { enabled: true, initializing: Boolean(defaultService) && !initializationError,
    error: initializationError || null, running: false, pending: 0, work: [], checks: [] };
}

export async function stopDefaultKnowledgeService() {
  const current = defaultService; defaultService = null; resolvedService = null; initializationError = null;
  await (await current)?.close();
}
