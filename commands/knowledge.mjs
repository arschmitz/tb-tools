import config from "../lib/config.mjs";
import { runKnowledgeCommand } from "./knowledge/cli.mjs";
import { generateConsoleKnowledge } from "./knowledge-service.mjs";

export default async function knowledgeCommand(argv = []) {
  return runKnowledgeCommand(argv, { config, generate: generateConsoleKnowledge });
}
