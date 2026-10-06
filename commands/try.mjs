import { run, getUrls } from "../lib/utils.mjs";
import { comment as defaultComment } from "../lib/phab.mjs";
import ora from "ora";
import path from "path";
import { prepareMonitoredTry, saveTrySubmissionOutput, finishTrySubmission } from "./graph/try-submission.mjs";

export function getMachTryArgs(options) {
  const selector = options.selector || (options.query ? "fuzzy" : "auto");
  const args = ["try", selector];

  if (selector === "fuzzy" && options.query) {
    args.push("--query", options.query);
  }

  if (selector === "auto" && options["tasks-regex"]) {
    args.push("--tasks-regex", options["tasks-regex"]);
  }

  if (options.preset) {
    args.push("--preset", options.preset);
  }

  if (options.artifact === false) {
    args.push("--no-artifact");
  } else if (options.artifact !== "false") {
    args.push("--artifact");
  }

  if (options.message) args.push("--message", options.message);

  return args;
}

export function getTryUrl(output) {
  const urls = getUrls(output) || [];
  return urls[urls.length - 1];
}

export function createTryCommand({ runCommand = run, postComment = defaultComment, prepareMonitor = runCommand === run ? prepareMonitoredTry : null } = {}) {
  return async function tryCommand(options = {}) {
    const tracking = prepareMonitor ? await prepareMonitor({ options }) : null;
    let tryUrl;
    try {
      const marker = tracking?.state.attempts.at(-1).marker;
      const output = await runCommand({
        cmd: path.join("..", "mach"),
        args: getMachTryArgs(marker ? { ...options, message: `${options.message || "{msg}"}\n\n${marker}` } : options),
        capture: true,
        ...(tracking ? {
          onStdout: text => saveTrySubmissionOutput(tracking.state, tracking.store, text),
          onStderr: text => saveTrySubmissionOutput(tracking.state, tracking.store, text),
        } : {}),
      });
      tryUrl = getTryUrl(output);
      if (tracking) finishTrySubmission(tracking.state, tracking.store, tryUrl);
    } catch (error) {
      if (tracking) {
        tracking.state.error = `Try submission needs reconciliation: ${error.message}`;
        tracking.store.save(tracking.state);
      }
      throw error;
    } finally {
      tracking?.release();
    }

    if (options.comment) {
      if (!tryUrl) {
        throw new Error("Could not find a try URL in mach try output.");
      }

      const spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
      try {
        await postComment({ message: `try: ${tryUrl}` });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        throw error;
      }
    }

    return tryUrl;
  };
}

export default createTryCommand();
