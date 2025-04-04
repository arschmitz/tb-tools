import { run, getUrls } from "./utils.mjs";

export async function getCommitMessage() {
  const message = await hg("log -v --limit 1");
  return message.split(/\ndescription:\n/)[1];
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
  await hg(`pull ${repo}`, cwd);
  await hg(`up ${repo}`, cwd);
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