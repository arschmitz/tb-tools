import chalk from "chalk";
import ora from "ora";
import { run, getUrls } from "./utils.mjs";
import { checkbox, input } from "@inquirer/prompts";

export async function getCommitMessage() {
  return await hg("log --template {desc} -l 1");
}

export async function getReviewers() {
  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  return messageParts[messageParts.length - 1].split(",");
}

export async function getIndividualReviewers() {
  return (await getReviewers()).filter((item) => !/^#/.test(item)).join(",");
}

export async function getGroupReviewers() {
  return (await getReviewers()).filter((item) => /^#/.test(item)).join(",");
}

export async function getRevision() {
  const message = await getCommitMessage();
  const urls = getUrls(message);
  const phabUrl = urls[urls.length -1];
  const parts = phabUrl.split("/");
  return parts[parts.length -1];
}

export async function pullUp(repo = "comm") {
  const cwd = repo === "comm" ? "." : "..";
  const status = ora({
    text: `Updating ${repo}`,
    spinner: "aesthetic"
  }).start();

  await hg(`pull ${repo}`, cwd, true);
  await hg(`up ${repo}`, cwd, true);

  status.succeed();
}

export async function hg(command, cwd, silent) {
  return run({cmd: "hg", cwd, args: command.split(" "), capture: true, silent });
}

export async function getCommit() {
  return hg("id -i");
}

export async function getStackParent() {
  return hg("log -r first(stack()) --template {node}");
}

export async function getFileStatus({ modified = true, added = true, removed = true, untracked = true } = {}) {
  const status = await hg("status", undefined, true);
  let files = status.split("\n").reduce((collection, file) => {
    if (file.substring(0,1) === "") {
      return collection;
    }
    collection.push({status: file.substring(0,1), file: file.substring(2, file.length) });

    return collection;
  }, []);

  if (!modified) {
    files = files.filter(({status}) => status !== "M");
  }

  if (!added) {
    files = files.filter(({status}) => status !== "A");
  }

  if (!removed) {
    files = files.filter(({status}) => status !== "!");
  }

  if (!untracked) {
    files = files.filter(({status}) => status !== "?");
  }

  return files;
}

export async function addRemoveFiles() {
  const files = await getFileStatus({ modified: false, added: false });

  const choices = files.map((file) => {
    const color = file.status === "!" ? chalk.red : chalk.green;
    return {
      name: `${color(file.status === "!" ? "Removed" : "Added" )} - ${file.file}`,
      value: file
    }
  });

  if (!choices.length) {
    return;
  }

  const filesToUpdate = await checkbox({ message: "Select files to add or remove", choices, pageSize: 30 });

  for(const file of filesToUpdate) {
    try{
      await hg(`${file.status === "?" ? "add" : "forget"} ${file.file}`, undefined, true);
    } catch (error) {
      console.error(error);
    }
  }
}

export async function amend() {
  await addRemoveFiles();
  const message = await getCommitMessage();
  await run({ cmd: "hg", args: [ "commit", "--amend", "-m", message ], silent: true });
}

export async function getBookmark() {
  return hg("log -r . -T {activebookmark}", undefined, true);
}

export async function commit() {
  const bookmark = await getBookmark();
  const prefix = bookmark.split("_")[0].replace("-", " ");
  const text = await input({ message: "Enter commit message:", required: true });
  const reviewers = await input({ message: "Enter reviewers seperated by commas:" });
  const message = `${prefix} - ${text}. r=${reviewers}`;

  await addRemoveFiles()

  try {
    await run({
      cmd: "hg",
      args: ["commit", "-m", message],
      silent: true
    });

    console.info(`${chalk.green("✓ Created new commit - ")} ${message}`);
  } catch (error) {
    console.error(error);
    console.info(`${chalk.red("✖ No changes found")}`);
  }
}
export async function handleConflict() {
  await hg("rebase --config=ui.merge=internal:merge --source=58047 --dest=58052");
}