import testChanged from "./test.mjs";
import _try from "./try.mjs";
import { comment } from "../lib/phab.mjs";
import {
  chainCommands,
  checkForChanges,
  spawnCommand,
} from "../lib/utils.mjs";

const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];
export default async function(options) {
  try {
    await checkForChanges("Changes found please ammend, commit or shelve your changes.");

    if (options.lint) {
      await Promise.all(lintDirs.map((dir) => spawnCommand(`../mach commlint ${dir} --fix`)));
      await checkForChanges("Files updated by lint.");
    }

    if (options.test) {
      await testChanged();
    }

    if (options.try) {
      const tryLink = await _try(options);

      comment(`try: ${tryLink}`, options.resolve);
    } else if (options.resolve) {
      comment("", true);
    }

    await chainCommands(['moz-phab submit']);

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}