import readlineSync from "readline-sync";
import open from "open";
import phab from "../lib/phab.mjs";
import chalk from 'chalk';
import { hg } from "../lib/hg.mjs";
import { run } from "../lib/utils.mjs";
import { getCommitMessage, getIndividualReviewers, } from "../lib/hg.mjs";
import { select, Separator } from '@inquirer/prompts';
import { getBugs, getAttachments } from "../lib/bugzilla.mjs";
import update from "./update.mjs";

export default async function () {
  await update();
  const bugs = await getBugs();
  for(const bug of bugs.bugs) {
    const attachments = await getAttachments(bug.id);

    const phabIds = attachments.reduce((collection, attachment) => {
      if (attachment.content_type === 'text/x-phabricator-request') {
        collection.push(attachment.file_name.match(/D[0-9]{6}/)[0].replace("D", ""));
      }

      return collection;
    }, []);

    bug.patches = new Set((await phab({ route: "differential.query", params: { ids: phabIds }})).result);

  }

  await pickPatch(new Set(bugs.bugs));

  await hg("out -r .");

  const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

  if (correct) {
    await hg("push -r . ssh://hg.mozilla.org/comm-central");
  } else if (correct === false) {
    process.exit(1);
  } else {
    console.info("Rolling back changes");
    await hg("prune .");
    process.exit(1);
  }
}

async function pickPatch(_bugs) {
  const choices = []
  for(const bug of Array.from(_bugs)) {
    choices.push(new Separator(chalk.yellow(`Bug ${bug.id} - ${bug.summary}`.substring(0, process.stdout.columns - 3))));

    bug.patches.forEach((patch) => {
      const color = patch.statusName === "Accepted" ? chalk.green : chalk.red;
      const status = color(`D${patch.id} [${patch.statusName}]`);
      choices.push({
        name: `${status} - ${patch.title}`.substring(0, process.stdout.columns - 3),
        value: {
          bug,
          patch,
        }
      });
    });
  }

  choices.push(new Separator(chalk.magenta("Actions:")));
  choices.push({ name: "Continue", value: "continue" });
  choices.push({ name: "Abort", value: "abort" });

  const choice = await select({
    choices,
    message: chalk.green.underline.bold("Select a patch to land or an action:"),
    pageSize: 30
  });

  if (typeof choice === "object") {
    const next = await checkPatch(choice);
    await next();
    choice.bug.patches.delete(choice.patch);
    if (!choice.bug.patches.size) {
      _bugs.delete(choice.bug);
    }
    await pickPatch(_bugs);
  } else if (choice === "abort") {
    process.exit(1);
  }
}

async function checkPatch(choice) {
  return select({
    message: "Select an option:",
    choices: [
      { name: "Open Bug",
        value: async () => {
          open(`https://bugzilla.mozilla.org/show_bug.cgi?id=${choice.bug.id}`);
          const next = await checkPatch(choice);
          next();
        }
      },
      {
        name: "Open Patch",
        value: async () => {
          open(choice.patch.uri);
          const next = await checkPatch(choice);
          next();
        }
      },
      {
        name: "Merge Patch",
        value: async () => {
          await mergePatch(`D${choice.patch.id}`);
        }
      }
    ]
  },{
    clearPromptOnDone: true
  });
}

async function mergePatch(patchNumber) {
  console.info(`Merging ${patchNumber}… `);

  await run({ cmd: "moz-phab", args:["patch", patchNumber, "--no-bookmark", "--skip-dependencies", "--apply-to", "."]});

  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  const reviewers = await getIndividualReviewers();
  messageParts.pop();
  messageParts.push(reviewers);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await run({ cmd: "hg", args: [ "commit", "--amend", "--date", "now", "-m", lines.join("\n") ] });
}
