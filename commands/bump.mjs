import readlineSync from "readline-sync";
import update from "./update.mjs";
import { hg } from "../lib/hg.mjs";
import { mach, run } from "../lib/utils.mjs";
import { readFile, writeFile } from 'node:fs/promises';

export default async function () {
  try {
    await update();
    await mach("tb-rust check-upstream");
    await update_dummy();

    await run({
      cmd: "hg",
      args: ["commit", "-m", `"No bug, trigger build."`]
    });
    await hg("out -r .");

    const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

    if (correct) {
      await hg("push -r . ssh://hg.mozilla.org/comm-central");
    } else if (correct === false) {
      process.exit(1);
    } else {
      console.info("Rolling back changes");
      await hg("prune .");
      process.exit(1);
    }

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function update_dummy() {
  const contents = await readFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', { encoding: 'utf8' });
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
