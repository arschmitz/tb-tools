import openUrl from "open";
import { getWorkspaceContext } from "../lib/workflow.mjs";

const TARGETS = new Set(["bug", "phab", "try", "all"]);

export function getRequestedTargets(options = {}) {
  if (options.target) {
    const targets = Array.isArray(options.target) ? options.target : [options.target];
    return targets.map((target) => target.toLowerCase()).filter((target) => TARGETS.has(target));
  }

  const targets = [];

  if (options.bug) {
    targets.push("bug");
  }

  if (options.phab) {
    targets.push("phab");
  }

  if (options.try) {
    targets.push("try");
  }

  if (options.all || !targets.length) {
    targets.push("all");
  }

  return targets;
}

export function getUrlsForTargets(context, targets) {
  const requested = new Set(targets.includes("all") ? ["bug", "phab", "try"] : targets);
  const urls = [];

  if (requested.has("bug") && context.bugUrl) {
    urls.push(context.bugUrl);
  }

  if (requested.has("phab") && context.phabUrl) {
    urls.push(context.phabUrl);
  }

  if (requested.has("try") && context.tryUrl) {
    urls.push(context.tryUrl);
  }

  return urls;
}

export function createOpenCommand({
  getContext = getWorkspaceContext,
  open = openUrl,
  write = console.log,
} = {}) {
  return async function openCommand(options = {}) {
    const context = await getContext(options);
    const targets = getRequestedTargets(options);
    const urls = getUrlsForTargets(context, targets);

    if (!urls.length) {
      throw new Error(`No ${targets.join(", ")} link found for the current work.`);
    }

    for (const url of urls) {
      write(`Opening ${url}`);
      await open(url);
    }
  };
}

export default createOpenCommand();
