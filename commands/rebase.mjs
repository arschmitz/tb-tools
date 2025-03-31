import update from "./update.mjs";
import { chainCommands, checkDir  } from "../lib/utils.mjs";

export default async function rebase({ build, run }) {
  try {
    checkDir();
    const startCommit = await chainCommands([{ cmd: 'hg id -i', execute: true }]);
    let shelved;
    try {
      await chainCommands(["hg shelve"]);
      shelved = true;
    } catch {
      // no changes to shelve
    }
    await update();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tip = await chainCommands([{ cmd: 'hg id -i', execute: true }]);
    await chainCommands([`hg up ${startCommit}`]);
    let stackParent;
    try {
      stackParent = await chainCommands([{
        cmd: "hg log -r 'first(stack())' --template '{node}'",
        execute: true
      }]);
    } catch {
      // no stack
    }
    if (stackParent) {
      try {
        await chainCommands([
          `hg rebase -b ${stackParent} -d ${tip}`
        ]);
      } catch {
        // nothing to rebase
      }
    }
    if (shelved) {
      await chainCommands(["hg unshelve"]);
    }

    if (build || run) {
      await chainCommands(["../mach build"]);
    }

    if (run) {
      await chainCommands(["../mach run"])
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}