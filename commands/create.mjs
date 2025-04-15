import update from "./update.mjs";
import { input } from "@inquirer/prompts";
import { hg } from "../lib/hg.mjs";
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

  const bookmarkData = await run({
    cmd: "hg",
    args: ["bookmark", "--list", "--template", `{bookmarks % '{bookmark}\\n'}`],
    silent: true,
    capture: true,
  });
  let bookmarks = bookmarkData.split("\n");

  if (bookmarks.includes(name)) {
    const dupTest = new RegExp(`${name}_([0-9]{1,3})`);
    let patchCount = 1;
    if (bookmarks.some((bookmark) => dupTest.test(bookmark))) {
      patchCount = bookmarks.reduce((highest, bookmark) => {
        if (!dupTest.test(bookmark)) {
          return highest;
        }
        const number = parseInt(bookmark.match(dupTest)[1]);
        return number > highest ? number : highest;
      }, 1);
      patchCount = parseInt(patchCount);
      patchCount++;
    }
    name = `${name}_${patchCount}`;
  }

  await hg(`bookmark ${name}`);
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