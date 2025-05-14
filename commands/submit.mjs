import testChanged from "./test.mjs";
import _try from "./try.mjs";
import rebase from "./rebase.mjs";
import lint from "./lint.mjs";
import ora from "ora";
import readlineSync from "readline-sync";
import { comment } from "../lib/phab.mjs";
import {
  checkForChanges,
  run,
} from "../lib/utils.mjs";

export default async function(options, tryOptions) {
  try {
    await checkForChanges("Changes found please ammend, commit or shelve your changes.");

    const lintAnswer = readlineSync.keyInYNStrict("Do you want to run lint? [y/n]:", { guide: false });
    
    if (lintAnswer) {
      try {
        await lint();
        await checkForChanges("Files updated by lint.");
      } catch (error) {
        const force = readlineSync.keyInYNStrict("Build Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          console.error(error);
          process.exit(1);
        }
      }
    }

    const testAnswer = readlineSync.keyInYNStrict("Do you want to run tests? [y/n]:", { guide: false });
    
    if (testAnswer) {
      try {
        await testChanged();
      } catch (error) {
        const force = readlineSync.keyInYNStrict("tests Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          console.error(error);
          process.exit(1);
        }
      }
    }

    await run({ cmd: 'moz-phab', args: ["submit"]});

    const tryAnswer = readlineSync.keyInYNStrict("Do you want to post a try run? [y/n]:", { guide: false });
    const resolveAnswer = readlineSync.keyInYNStrict("Do you want to resolve and post inline comments? [y/n]:", { guide: false });

    let spinner;
    if (tryAnswer || resolveAnswer) {
      spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
    }

    if (tryAnswer) {
      try {
        const tryLink = await _try(options, tryOptions);
        await comment({ message: `try: ${tryLink}`, resolve: resolveAnswer });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        console.error(error);
      }
    } else if (resolveAnswer) {
      try {
        await comment({ message: "", resolve: true });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        console.error(error);
      }
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}