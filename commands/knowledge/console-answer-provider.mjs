import os from "node:os";
import config from "../../lib/config.mjs";
import { generateConsoleKnowledge } from "../knowledge-service.mjs";
import { createKnowledgeAnswerProvider } from "./answer-provider.mjs";

const provider = createKnowledgeAnswerProvider({ generate: generateConsoleKnowledge,
  command: config.ai?.command, directory: os.tmpdir() });
export const configuration = provider.configuration;
export const generate = request => provider.generate(request);
