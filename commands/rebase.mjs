import update from "./update.mjs";
import { getCommit, getStackParent, hg } from "../lib/hg.mjs";
import { mach } from "../lib/utils.mjs";

export default async function rebase({ build, run } = {}) {
  try {
    const startCommit = await getCommit();
    let shelved;
    try {
      await hg("shelve");
      shelved = true;
    } catch {
      // no changes to shelve
    }
    await update();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tip = await getCommit();
    await hg(`up ${startCommit}`);
    let stackParent;
    try {
      stackParent = await getStackParent();
    } catch {
      // no stack
    }
    if (stackParent) {
      try {
        await hg(`rebase -b ${stackParent} -d ${tip}`);
      } catch {
        // nothing to rebase
      }
    }
    if (shelved) {
      await hg("unshelve");
    }

    if (build || run) {
      await mach("build");
    }

    if (run) {
      await mach("run");
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}