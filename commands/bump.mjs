import readlineSync from "readline-sync";
import update from "./update.mjs";
import { discardLastCommit, ensureWorkingTreeClean, git, showPendingCommits } from "../lib/git.mjs";
import { pushCommits } from "../lib/lando.mjs";
import { readFile, writeFile } from 'node:fs/promises';
import path from "path";

export default async function (options = {}) {
  await ensureWorkingTreeClean();
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
    throw new Error("Bump aborted.");
  } else {
    console.info("Rolling back changes");
    await discardLastCommit();
    throw new Error("Bump rolled back.");
  }
}

async function update_dummy() {
  const dummyPath = path.join(process.cwd(), "build", "dummy");
  const contents = await readFile(dummyPath, { encoding: 'utf8' });
  const lines = contents.split(/\n/);
  let dotLine = lines[lines.length - 2];
  const dots = dotLine.match(/\./g) || [];

  if (dots.length <= 1) {
    dotLine = '..'
  } else {
    dots.pop()
    dotLine = dots.join('');
  }

  lines[lines.length - 2] = dotLine;

  const newContent = lines.join('\n');

  await writeFile(dummyPath, newContent);

  console.log('Updated Dummy File');
}
