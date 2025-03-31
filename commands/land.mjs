import readlineSync from "readline-sync";
import { chainCommands } from "../lib/utils.mjs";

export default async function () {
  await landPatch();
  await chainCommands([
    "hg out -r .",
  ]);

  const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

  if (correct) {
    await chainCommands([{
      cmd: "hg",
      args: ["push", "-r", ".", "ssh://hg.mozilla.org/comm-central"],
    }]);
  } else if (correct === false) {
    process.exit(1);
  } else {
    console.info("Rolling back changes");
    await chainCommands([
      {
        cmd: "hg",
        args: ["prune", "."],
      }
    ]);
    process.exit(1);
  }
}

async function landPatch() {
  const patchNumber = readlineSync.question("Enter DXXXX number of patch:");

  console.info(`Landing ${patchNumber}… Please update the patch comment with the actual approver and remove any review groups`);

  await chainCommands([
    `moz-phab patch ${patchNumber} --no-bookmark --skip-dependencies --apply-to .`,
  ]);

  const message = await chainCommands([{ cmd: "hg log -v --limit 1", execute: true }]);
  const lines = message.split(/\ndescription:\n/)[1].split(/\n/);
  const messageParts = lines[0].split(".");
  console.log("message", messageParts)
  const reviewers = messageParts[messageParts.length - 1].split(",").filter((item) => !/^#/.test(item)).join(",");
  messageParts.pop();
  messageParts.push(reviewers);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await chainCommands([
    { cmd: "hg", args: [ "commit", "--amend", "--date", "now", "-m", lines.join("\n") ] },
  ]);

  const correct = readlineSync.keyInYN("Would you like to add another patch? [y/n]:", { guide: false });

  if (correct) {
    await landPatch();
  }
}
