import readlineSync from "readline-sync";
import open from "open";
import phab, { comment } from "../lib/phab.mjs";
import chalk from 'chalk';
import ora from "ora";
import { createCheckpoint, ensureWorkingTreeClean, git, restoreCheckpoint, showPendingCommits } from "../lib/git.mjs";
import { run, mach } from "../lib/utils.mjs";
import { getCommitMessage } from "../lib/git.mjs";
import { pushCommits } from "../lib/lando.mjs";
import { select, Separator, input } from '@inquirer/prompts';
import { getBugs, getAttachments, updateBug } from "../lib/bugzilla.mjs";
import update from "./update.mjs";
import bump from "./bump.mjs";
import lint from "./lint.mjs";
import fs from "fs";
import path from "path";
const landed = [];

export default async function (options = {}) {
  await ensureWorkingTreeClean();
  await update();
  const landingCheckpoint = await createCheckpoint("landing-start");
  const spinner = ora({
    text: `Fetching bugs`,
    spinner: "aesthetic"
  }).start();

  let bugs;
  try {
    bugs = await getBugs();
    if (!bugs.length) {
      spinner.succeed();
      const shouldBump = readlineSync.keyInYN("No bugs marked for checkin. Bump dummy file? [y/n/c]:", { guide: false });
      if (shouldBump) {
        await bump();
      }

      return;
    }
    for(const bug of bugs) {
      const attachments = await getAttachments(bug.id);

      const phabIds = attachments.reduce((collection, attachment) => {
        if (attachment.content_type === 'text/x-phabricator-request') {
          collection.push(attachment.file_name.match(/D[0-9]{6}/)[0].replace("D", ""));
        }

        return collection;
      }, []);

      bug.patches = new Set((await phab({ route: "differential.query", params: { ids: phabIds }})).result);
      for(const patch of Array.from(bug.patches)) {
        const response = await phab({ route: "user.query", params: {
          phids: Object.keys(patch.reviewers),
        }});

        const names = response.result.map((reviewer) => reviewer.userName);
        patch.bugId = bug.id;
        patch.reviewers = names;
      }
    }
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    throw error;
  }

  await pickPatch(new Set(bugs));

  const lintAnswer = readlineSync.keyInYNStrict("Do you want to run lint? [y/n]:", { guide: false });

  if (lintAnswer) {
    try {
      await lint();
    } catch (error) {
      const rollAnswer = readlineSync.keyInYNStrict("Lint Failed: Do you want to roll back changes? [y/n]:", { guide: false });

      console.error(error);

      if (rollAnswer) {
        await restoreCheckpoint(landingCheckpoint);
      }

      process.exit(1);
    }
  }

  const buildAnswer = readlineSync.keyInYNStrict("Do you want to run build? [y/n]:", { guide: false });

  if (buildAnswer) {
    try {
      await mach("build");
    } catch (error) {
      const rollAnswer = readlineSync.keyInYNStrict("Build Failed: Do you want to roll back changes? [y/n]:", { guide: false });

      console.error(error);

      if (rollAnswer) {
        await restoreCheckpoint(landingCheckpoint);
      }

      process.exit(1);
    }
  }

  await showPendingCommits();

  const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

  if (correct) {
    await pushCommits({
      landoRepo: options["lando-repo"],
      relbranch: options.relbranch,
      yes: true,
    });
  } else if (correct === false) {
    process.exit(1);
  } else {
    console.info("Rolling back changes");
    await restoreCheckpoint(landingCheckpoint);
    process.exit(1);
  }

  const version = fs.readFileSync(path.join(".", "mail", "config", "version.txt"), { encoding: "utf-8" });
  const simpleVersion = version.split(".")[0];
  const mileStone = `${simpleVersion} Branch`;

  for(const bug of landed) {
    const updates = {};
    if (bug.target_milestone === "---") {
      updates.target_milestone = await input({ message: "Enter target milestone:", default: mileStone, required: true });

      await updateBug(bug.id, updates);
    }
  }
}

async function pickPatch(_bugs) {
  const choices = [];

  choices.push(new Separator(chalk.magenta("Actions:")));
  choices.push({ name: "Continue", value: "continue" });
  choices.push({ name: "Abort", value: "abort" });

  const iterator = Array.from(_bugs);

  iterator.reverse();

  for(const bug of iterator) {
    choices.push(new Separator(chalk.yellow(`Bug ${bug.id} - ${bug.summary}`.substring(0, process.stdout.columns - 3))));

    bug.patches.forEach((patch) => {
      if (patch.statusName === "Closed") {
        return;
      }
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

  const choice = await select({
    choices,
    message: chalk.green.underline.bold("Select a patch to land or an action:"),
    pageSize: 20
  });

  if (typeof choice === "object") {
    const next = await checkPatch(choice);

    console.log({next})

    if (typeof next === "function") {
      await next();
      choice.bug.patches.delete(choice.patch);
      if (!choice.bug.patches.size) {
        landed.push(choice.bug);
        _bugs.delete(choice.bug);
      }
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
      {
        name: "Open Bug",
        value: async () => {
          open(`https://bugzilla.mozilla.org/show_bug.cgi?id=${choice.bug.id}`);
          const next = await checkPatch(choice);
          return next();
        }
      },
      {
        name: "Open Patch",
        value: async () => {
          open(choice.patch.uri);
          const next = await checkPatch(choice);
          return next();
        }
      },
      {
        name: "Merge Patch",
        value: async () => {
          await mergePatch(choice.patch);
        }
      },
      {
        name: "Skip Patch",
        value: async () => {}
      },
      {
        name: "Go Back",
        value: false,
      }
    ]
  },{
    clearPromptOnDone: true
  });
}

async function mergePatch(patch) {
  const spinner = ora({
    text: `Merging D${patch.id}… `,
    spinner: "aesthetic"
  }).start();

  try {
    await run({ cmd: "moz-phab", args:["patch", `D${patch.id}`, "--skip-dependencies", "--apply-to", "here"], capture: true, silent: true });
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    if (/uncommitted/.test(error.message)) {
      throw error;
    }

    if (/patch failed|conflict|CONFLICT|error:/i.test(error)) {
      const correct = readlineSync.keyInYNStrict("Add comment to phabricator? [y/n]:", { guide: false });

      if (correct) {
        const commentSpinner = ora({
          text: `Commenting on patch`,
          spinner: "aesthetic"
        }).start();
        try {
          await comment({ message: "Conflicts found while landing. Please Rebase.", id: patch.id });
          commentSpinner.succeed();
        } catch {
          commentSpinner.fail();
        }
      }

      const bugComment = readlineSync.keyInYNStrict("Add comment to bugzilla? [y/n]:", { guide: false });

      if (bugComment) {
        const commentSpinner = ora({
          text: `Commenting on patch`,
          spinner: "aesthetic"
        }).start();
        try {
          updateBug(patch.bugId, {
            comment: {
              body: "Conflicts found while landing. Please Rebase."
            },
            keywords: {
              remove: ["checkin-needed-tb"]
            }
          });
          commentSpinner.succeed();
        } catch {
          commentSpinner.fail();
        }
      }
    }
  }

  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  messageParts.pop();
  messageParts.push(` r=${patch.reviewers.join(",")}`);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await git([ "commit", "--amend", "--date=now", "-m", lines.join("\n") ]);
}
