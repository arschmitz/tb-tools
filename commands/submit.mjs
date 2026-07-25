import defaultTestChanged from "./test.mjs";
import defaultTry from "./try.mjs";
import defaultLint from "./lint.mjs";
import ora from "ora";
import readlineSync from "readline-sync";
import { comment as defaultComment } from "../lib/phab.mjs";
import {
  checkForChanges,
  run,
} from "../lib/utils.mjs";

export function createSubmitCommand({
  checkChanges = checkForChanges,
  lint = defaultLint,
  testChanged = defaultTestChanged,
  tryCommand = defaultTry,
  prompts = readlineSync,
  postComment = defaultComment,
  runCommand = run,
} = {}) {
  return async function submit(options, tryOptions) {
    await checkChanges("Changes found please amend, commit, or stash your changes.");

    const lintAnswer = prompts.keyInYNStrict("Do you want to run lint? [y/n]:", { guide: false });
    
    if (lintAnswer) {
      try {
        await lint();
        await checkChanges("Files updated by lint.");
      } catch (error) {
        const force = prompts.keyInYNStrict("Build Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          throw error;
        }
      }
    }

    const testAnswer = prompts.keyInYNStrict("Do you want to run tests? [y/n]:", { guide: false });
    
    if (testAnswer) {
      try {
        await testChanged();
      } catch (error) {
        const force = prompts.keyInYNStrict("tests Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          throw error;
        }
      }
    }

    await runCommand({ cmd: 'moz-phab', args: ["submit"]});

    const tryAnswer = prompts.keyInYNStrict("Do you want to post a try run? [y/n]:", { guide: false });
    const resolveAnswer = prompts.keyInYNStrict("Do you want to resolve and post inline comments? [y/n]:", { guide: false });

    let spinner;

    if (tryAnswer) {
      try {
        const tryLink = await tryCommand({ ...options, comment: false }, tryOptions);
        if (!tryLink) {
          throw new Error("Could not find a try URL in mach try output.");
        }

        spinner = new ora({
          text: "Posting comment to phabricator"
        }).start();
        await postComment({ message: `try: ${tryLink}`, resolve: resolveAnswer });
        spinner.succeed();
      } catch (error) {
        spinner?.fail();
        console.error(error);
      }
    } else if (resolveAnswer) {
      spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
      try {
        await postComment({ message: "", resolve: true });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        console.error(error);
      }
    }
  };
}

export default createSubmitCommand();
