import readlineSync from "readline-sync";
import update from "./update.mjs";
import { discardLastCommit, git, showPendingCommits } from "../lib/git.mjs";
import { pushCommits } from "../lib/lando.mjs";
import { readFile, writeFile } from 'node:fs/promises';
import path from "path";

export default async function (options = {}) {
  try {
    await update();
    await update_dummy();

    await git(["add", "--", "build/dummy"]);
    await git(["commit", "-m", `No bug, trigger build.`]);
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
      await discardLastCommit();
      process.exit(1);
    }

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function update_dummy() {
  const contents = await readFile(path.join(process.cwd(), "build", "dummy"), { encoding: 'utf8' });
  const lines = contents.split(/\n/);
  let dotLine = lines[lines.length - 2];
  const dots = dotLine.match(/\./g)

  if (dots.length === 1) {
    dotLine = '..'
  } else {
    dots.pop()
    dotLine = dots.join('');
  }

  lines[lines.length - 2] = dotLine;

  const newContent = lines.join('\n');

  await writeFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', newContent);

  console.log('Updated Dummy File');
}
