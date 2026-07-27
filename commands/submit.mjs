import defaultTestChanged from "./test.mjs";
import defaultTry from "./try.mjs";
import defaultLint from "./lint.mjs";
import ora from "ora";
import readlineSync from "readline-sync";
import { comment as defaultComment } from "../lib/phab.mjs";
import { getCommitMessage as defaultGetCommitMessage } from "../lib/git.mjs";
import {
  checkForChanges,
  run,
} from "../lib/utils.mjs";
import {
  getPhabRevisionFromText,
  getPhabUrl,
  getTryUrlFromText,
} from "../lib/workflow.mjs";

export function getSubmitLinksFromText(text = "", { tryLink = "" } = {}) {
  const phabRevision = getPhabRevisionFromText(text);
  const detectedTryUrl = tryLink || getTryUrlFromText(text);

  return {
    phabRevision,
    phabUrl: phabRevision ? getPhabUrl(phabRevision) : undefined,
    tryUrl: detectedTryUrl || undefined,
  };
}

export function createSubmitCommand({
  checkChanges = checkForChanges,
  lint = defaultLint,
  testChanged = defaultTestChanged,
  tryCommand = defaultTry,
  prompts = readlineSync,
  postComment = defaultComment,
  getCommitMessage = defaultGetCommitMessage,
  runCommand = run,
  createSpinner = (text) => new ora({ text }).start(),
} = {}) {
  return async function submit(options, tryOptions) {
    await checkChanges("Changes found please amend, commit, or stash your changes.");

    const result = {
      phabRevision: undefined,
      phabUrl: undefined,
      tryUrl: undefined,
    };

    const lintAnswer = await prompts.keyInYNStrict("Do you want to run lint? [y/n]:", { guide: false });
    
    if (lintAnswer) {
      try {
        await lint();
        await checkChanges("Files updated by lint.");
      } catch (error) {
        const force = await prompts.keyInYNStrict("Build Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          throw error;
        }
      }
    }

    const testAnswer = await prompts.keyInYNStrict("Do you want to run tests? [y/n]:", { guide: false });
    
    if (testAnswer) {
      try {
        await testChanged({
          flavor: options.flavor,
          pattern: options.pattern,
        });
      } catch (error) {
        const force = await prompts.keyInYNStrict("tests Failed: Do you want to continue? [y/n]:", { guide: false });

        if (!force) {
          throw error;
        }
      }
    }

    const submitOutput = await runCommand({ cmd: 'moz-phab', args: ["submit"], capture: true });
    const commitMessage = await getCommitMessage().catch(() => "");
    Object.assign(result, getSubmitLinksFromText(`${submitOutput || ""}\n${commitMessage || ""}`));

    const tryAnswer = await prompts.keyInYNStrict("Do you want to post a try run? [y/n]:", { guide: false });
    const resolveAnswer = await prompts.keyInYNStrict("Do you want to resolve and post inline comments? [y/n]:", { guide: false });

    let spinner;

    if (tryAnswer) {
      try {
        const tryLink = await tryCommand({ ...options, comment: false }, tryOptions);
        if (!tryLink) {
          throw new Error("Could not find a try URL in mach try output.");
        }

        spinner = createSpinner("Posting comment to phabricator");
        result.tryUrl = tryLink;
        await postComment({ message: `try: ${tryLink}`, resolve: resolveAnswer, id: result.phabRevision?.replace(/^D/, "") });
        spinner.succeed();
      } catch (error) {
        spinner?.fail();
        console.error(error);
      }
    } else if (resolveAnswer) {
      spinner = createSpinner("Posting comment to phabricator");
      try {
        await postComment({ message: "", resolve: true, id: result.phabRevision?.replace(/^D/, "") });
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        console.error(error);
      }
    }

    return result;
  };
}

export default createSubmitCommand();
