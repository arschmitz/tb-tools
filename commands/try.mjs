import { run, getUrls } from "../lib/utils.mjs";
import { comment as defaultComment } from "../lib/phab.mjs";
import ora from "ora";
import path from "path";

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

  return args;
}

export function getTryUrl(output) {
  const urls = getUrls(output) || [];
  return urls[urls.length - 1];
}

export function createTryCommand({ runCommand = run, postComment = defaultComment } = {}) {
  return async function tryCommand(options = {}) {
    const output = await runCommand({
      cmd: path.join("..", "mach"),
      args: getMachTryArgs(options),
      capture: true,
    });

    const tryUrl = getTryUrl(output);

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
