import testChanged from "./test.mjs";
import _try from "./try.mjs";
import rebase from "./rebase.mjs";
import lint from "./lint.mjs";
import ora from "ora";
import { comment } from "../lib/phab.mjs";
import {
  checkForChanges,
  run,
} from "../lib/utils.mjs";

export default async function(options, tryOptions) {
  try {
    await checkForChanges("Changes found please ammend, commit or shelve your changes.");

    if (options.rebase) {
      await rebase();
    }

    if (options.lint) {
      await lint();
      await checkForChanges("Files updated by lint.");
    }

    if (options.test) {
      await testChanged();
    }

    await run({ cmd: 'moz-phab', args: ["submit"]});

    let spinner;
    if (options.try || options.resolve) {
      spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
    }
    if (options.try) {
      try {
        const tryLink = await _try(options, tryOptions);
        await comment(`try: ${tryLink}`, options.resolve);
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        throw error;
      }
    } else if (options.resolve) {
      try {
        await comment("", true);
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        throw error;
      }
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}