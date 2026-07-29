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
const LANDING_PHABRICATOR_QUERY_BATCH_SIZE = 100;
const LANDING_PATCH_DISCOVERY_EXCLUDED_BUG_IDS = new Set([
  "1878375",
]);

function isLandingPatchDiscoveryExcludedBug(bug) {
  return LANDING_PATCH_DISCOVERY_EXCLUDED_BUG_IDS.has(String(bug.id));
}

function getUniqueValues(values) {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

function chunkValues(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function getPatchesById(phabIds) {
  const patchesById = new Map();

  for (const ids of chunkValues(
    getUniqueValues(phabIds),
    LANDING_PHABRICATOR_QUERY_BATCH_SIZE,
  )) {
    const response = await phab({
      route: "differential.query",
      params: { ids },
    });

    for (const patch of response.result || []) {
      patchesById.set(String(patch.id), patch);
    }
  }

  return patchesById;
}

async function getReviewersByPhid(patches) {
  const reviewerPhids = getUniqueValues(patches.flatMap((patch) =>
    Object.keys(patch.reviewers || {})
  ));
  const reviewersByPhid = new Map();

  for (const phids of chunkValues(
    reviewerPhids,
    LANDING_PHABRICATOR_QUERY_BATCH_SIZE,
  )) {
    const response = await phab({
      route: "user.query",
      params: { phids },
    });

    for (const [index, reviewer] of (response.result || []).entries()) {
      reviewersByPhid.set(
        reviewer.phid || phids[index],
        reviewer.userName,
      );
    }
  }

  return reviewersByPhid;
}

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
    bugs = bugs.filter((bug) => !isLandingPatchDiscoveryExcludedBug(bug));

    if (!bugs.length) {
      spinner.succeed();
      const shouldBump = readlineSync.keyInYN("No bugs marked for checkin. Bump dummy file? [y/n/c]:", { guide: false });
      if (shouldBump) {
        await bump(options);
      }

      return;
    }

    const bugPhabricatorIds = new Map();
    const allPhabricatorIds = [];

    for(const bug of bugs) {
      const attachments = await getAttachments(bug.id);

      const phabIds = attachments.reduce((collection, attachment) => {
        if (attachment.content_type === 'text/x-phabricator-request') {
          const match = attachment.file_name.match(/D[0-9]+/);
          if (match) {
            collection.push(match[0].replace("D", ""));
          }
        }

        return collection;
      }, []);

      bugPhabricatorIds.set(bug, phabIds);
      allPhabricatorIds.push(...phabIds);
    }

    const patchesById = await getPatchesById(allPhabricatorIds);
    const allPatches = [];

    for (const [bug, phabIds] of bugPhabricatorIds) {
      bug.patches = new Set();

      for (const phabId of phabIds) {
        const patch = patchesById.get(String(phabId));

        if (patch) {
          patch.bugId = bug.id;
          allPatches.push(patch);
        }
      }
    }

    const reviewersByPhid = await getReviewersByPhid(allPatches);

    for (const [bug, phabIds] of bugPhabricatorIds) {
      for (const phabId of phabIds) {
        const patch = patchesById.get(String(phabId));

        if (!patch) {
          continue;
        }

        const names = Object.keys(patch.reviewers || {})
          .map((phid) => reviewersByPhid.get(phid))
          .filter(Boolean);

        patch.bugId = bug.id;
        patch.reviewers = names;
        bug.patches.add(patch);
      }
    }
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    throw error;
  }

  await pickPatch(new Set(bugs), landingCheckpoint);

  const lintAnswer = readlineSync.keyInYNStrict("Do you want to run lint? [y/n]:", { guide: false });

  if (lintAnswer) {
    try {
      await lint();
    } catch (error) {
      const rollAnswer = readlineSync.keyInYNStrict("Lint Failed: Do you want to roll back changes? [y/n]:", { guide: false });

      if (rollAnswer) {
        await restoreCheckpoint(landingCheckpoint, undefined, { clean: true });
      }

      throw error;
    }
  }

  const buildAnswer = readlineSync.keyInYNStrict("Do you want to run build? [y/n]:", { guide: false });

  if (buildAnswer) {
    try {
      await mach("build");
    } catch (error) {
      const rollAnswer = readlineSync.keyInYNStrict("Build Failed: Do you want to roll back changes? [y/n]:", { guide: false });

      if (rollAnswer) {
        await restoreCheckpoint(landingCheckpoint, undefined, { clean: true });
      }

      throw error;
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
    throw new Error("Landing aborted.");
  } else {
    console.info("Rolling back changes");
    await restoreCheckpoint(landingCheckpoint, undefined, { clean: true });
    throw new Error("Landing rolled back.");
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

async function pickPatch(_bugs, landingCheckpoint) {
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
    const next = await checkPatch(choice, landingCheckpoint);

    if (typeof next === "function") {
      const result = await next();

      if (["landed", "skipped"].includes(result)) {
        if (result === "landed") {
          choice.bug.hasLandedPatch = true;
        }

        choice.bug.patches.delete(choice.patch);

        if (!choice.bug.patches.size) {
          if (choice.bug.hasLandedPatch) {
            landed.push(choice.bug);
          }
          _bugs.delete(choice.bug);
        }
      }
    }

    await pickPatch(_bugs, landingCheckpoint);
  } else if (choice === "abort") {
    throw new Error("Landing aborted.");
  }
}

async function checkPatch(choice, landingCheckpoint) {
  return select({
    message: "Select an option:",
    choices: [
      {
        name: "Open Bug",
        value: async () => {
          open(`https://bugzilla.mozilla.org/show_bug.cgi?id=${choice.bug.id}`);
          const next = await checkPatch(choice, landingCheckpoint);
          return typeof next === "function" ? next() : next;
        }
      },
      {
        name: "Open Patch",
        value: async () => {
          open(choice.patch.uri);
          const next = await checkPatch(choice, landingCheckpoint);
          return typeof next === "function" ? next() : next;
        }
      },
      {
        name: "Merge Patch",
        value: async () => {
          return mergePatch(choice.patch, landingCheckpoint);
        }
      },
      {
        name: "Skip Patch",
        value: async () => "skipped"
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

async function mergePatch(patch, landingCheckpoint) {
  const spinner = ora({
    text: `Merging D${patch.id}… `,
    spinner: "aesthetic"
  }).start();

  try {
    await run({ cmd: "moz-phab", args:["patch", `D${patch.id}`, "--skip-dependencies", "--apply-to", "here"], capture: true, silent: true });
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    const message = String(error?.message || error);

    if (/uncommitted/.test(message)) {
      throw error;
    }

    if (/patch failed|conflict|CONFLICT|error:/i.test(message)) {
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
          await updateBug(patch.bugId, {
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

      await restoreCheckpoint(landingCheckpoint, undefined, { clean: true });
      return "skipped";
    }

    throw error;
  }

  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  messageParts.pop();
  messageParts.push(` r=${patch.reviewers.join(",")}`);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await git([ "commit", "--amend", "--date=now", "-m", lines.join("\n") ]);
  return "landed";
}
