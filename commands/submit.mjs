import testChanged from "./test.mjs";
import _try from "./try.mjs";
import rebase from "./rebase.mjs";
import lint from "./lint.mjs";
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

    if (options.try) {
      const tryLink = await _try(options, tryOptions);

      await comment(`try: ${tryLink}`, options.resolve);
    } else if (options.resolve) {

      await comment("", true);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}