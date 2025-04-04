import readlineSync from "readline-sync";
import { hg } from "../lib/hg.mjs";
import { run } from "../lib/utils.mjs";
import { getCommitMessage, getIndividualReviewers, } from "../lib/hg.mjs";

export default async function () {
  await landPatch();
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
}

async function landPatch() {
  const patchNumber = readlineSync.question("Enter DXXXX number of patch:");

  console.info(`Landing ${patchNumber}… Please update the patch comment with the actual approver and remove any review groups`);

  await run({ cmd: "moz-phab", args:["patch", patchNumber, "--no-bookmark", "--skip-dependencies", "--apply-to", "."]});

  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  const reviewers = await getIndividualReviewers();
  messageParts.pop();
  messageParts.push(reviewers);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await run({ cmd: "hg", args: [ "commit", "--amend", "--date", "now", "-m", lines.join("\n") ] });

  const correct = readlineSync.keyInYN("Would you like to add another patch? [y/n]:", { guide: false });

  if (correct) {
    await landPatch();
  }
}

async function getBugs() {
  const request = await fetch("https://bugzilla.mozilla.org/rest/bug?list_id=17500573&f1=keywords&v1=checkin-needed-tb&classification=Client%20Software&classification=Developer%20Infrastructure&classification=Components&classification=Server%20Software&classification=Other&query_format=advanced&bug_status=UNCONFIRMED&bug_status=NEW&bug_status=ASSIGNED&bug_status=REOPENED&bug_status=VERIFIED&resolution=---&o1=equals");
  const data = await request.json();

  
}
