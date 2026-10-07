import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const AI_SETTINGS_PATH = path.join(os.homedir(), ".tb-tools", "ai-settings.json");
export const AI_TASK_TYPES = [
  { id: "edit", label: "Review edits", description: "Apply a bounded change from a review.", effort: "medium" },
  { id: "conflict", label: "Conflict resolution", description: "Resolve ordinary rebase conflicts.", effort: "medium" },
  { id: "review", label: "Review, Verify, and Update", description: "Full reviews, assessments, and open-ended updates.", effort: "high" },
  { id: "implement", label: "Implementation", description: "Implement a bug or story. Verification uses Review settings.", effort: "medium" },
  { id: "diagnosis", label: "Try diagnosis", description: "Investigate a Try failure.", effort: "medium" },
  { id: "repair", label: "Repairs and complex conflicts", description: "Repair Try failures and resolve large or unmarked conflicts.", effort: "high" },
];
export const DEFAULT_AI_PROFILES = Object.fromEntries(AI_TASK_TYPES.map(task =>
  [task.id, { model: "gpt-6-sol", effort: task.effort }]));

export function readAiProfiles(filePath = AI_SETTINGS_PATH) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(filePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Could not read AI settings: ${error.message}`); }
  return Object.fromEntries(AI_TASK_TYPES.map(task => [task.id, { ...DEFAULT_AI_PROFILES[task.id], ...saved[task.id] }]));
}

export function saveAiProfiles(profiles, models, filePath = AI_SETTINGS_PATH) {
  const normalized = {};
  for (const task of AI_TASK_TYPES) {
    const profile = profiles?.[task.id];
    const model = models.find(model => !model.hidden && (model.model || model.id) === profile?.model);
    if (!model || !model.supportedReasoningEfforts?.some(option => option.reasoningEffort === profile?.effort)) {
      throw Object.assign(new Error(`Choose an available model and supported reasoning level for ${task.label}.`), { statusCode: 400 });
    }
    normalized[task.id] = { model: profile.model, effort: profile.effort };
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, filePath);
  return normalized;
}

export function selectAiModel(models, task, profiles = readAiProfiles()) {
  const profile = profiles[task];
  if (!profile) throw new Error(`Unknown AI task: ${task}`);
  const selected = models.find(model => !model.hidden && (model.model || model.id) === profile.model);
  if (!selected) throw new Error(`No available ${profile.model} model for ${task}. Change it in Settings; no other model was started.`);
  const supported = selected.supportedReasoningEfforts?.map(option => option.reasoningEffort) || [];
  if (!supported.includes(profile.effort)) {
    throw new Error(`${profile.model} does not support ${profile.effort} reasoning for ${task}. Change it in Settings.`);
  }
  return { model: selected.model || selected.id, effort: profile.effort };
}
