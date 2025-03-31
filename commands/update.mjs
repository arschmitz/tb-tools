import { chainCommands } from "../lib/utils.mjs";

export default async function update({ build = false, run = false } = {}) {
  try {
    await chainCommands([
      { cmd: "cd .. && hg pull central", execute: true },
      { cmd: "cd .. && hg up central", execute: true },
      "hg pull comm",
      "hg up comm",
      "../mach tb-rust check-upstream"
    ]);

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