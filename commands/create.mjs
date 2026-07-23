import update from "./update.mjs";
import { input } from "@inquirer/prompts";
import { git } from "../lib/git.mjs";
import { updateBug } from "../lib/bugzilla.mjs";
import { run } from "../lib/utils.mjs";
import ora from "ora";
import config from "../lib/config.mjs";

export default async function create({ update: _update = true }) {
  const bugId = await input({ message: "Enter bugzilla bug ID:", required: true, validate: (value) => /^[0-9]{4,7}$/.test(value) });
  let name = `Bug-${bugId}`;

  if (_update) {
    await update();
  }

  const branchData = await run({
    cmd: "git",
    args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    silent: true,
    capture: true,
  });
  const branches = branchData.split("\n");

  if (branches.includes(name)) {
    const dupTest = new RegExp(`${name}_([0-9]{1,3})`);
    let patchCount = 1;
    if (branches.some((branch) => dupTest.test(branch))) {
      patchCount = branches.reduce((highest, branch) => {
        if (!dupTest.test(branch)) {
          return highest;
        }
        const number = parseInt(branch.match(dupTest)[1]);
        return number > highest ? number : highest;
      }, 1);
      patchCount = parseInt(patchCount);
      patchCount++;
    }
    name = `${name}_${patchCount}`;
  }

  await git(["switch", "-c", name]);
  const spinner = ora({
    text: "Updating bugzilla"
  }).start();

  try {
    await updateBug(bugId, {
      assigned_to: config.bugzilla.user,
      status: "ASSIGNED",
    });
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    throw error;
  }
}
