import { run, getUrls } from "../lib/utils.mjs";
import { comment } from "../lib/phab.mjs";
import ora from "ora";
import path from "path";

export default async function (options) {
  try {
    const selector = options.selector || (options.query ? "fuzzy" : "auto");
    const machArgs = ["try", selector];

    if (selector === "fuzzy" && options.query) {
      machArgs.push("--query", options.query);
    }

    if (selector === "auto" && options["tasks-regex"]) {
      machArgs.push("--tasks-regex", options["tasks-regex"]);
    }

    if (options.preset) {
      machArgs.push("--preset", options.preset);
    }

    if (options.artifact === false) {
      machArgs.push("--no-artifact");
    } else if (options.artifact !== "false") {
      machArgs.push("--artifact");
    }

    const output = await run({
      cmd: path.join("..", "mach"),
      args: machArgs,
      capture: true,
    });

    const urls = getUrls(output) || [];
    const tryUrl = urls[urls.length - 1];

    if (options.comment) {
      if (!tryUrl) {
        throw new Error("Could not find a try URL in mach try output.");
      }

      const spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
      try {
        await comment({ message: `try: ${tryUrl}` });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        throw error;
      }
    }

    return tryUrl;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
