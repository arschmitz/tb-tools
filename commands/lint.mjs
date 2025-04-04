import { mach } from "../lib/utils.mjs";

const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];

export default async function lint() {
  await mach(`commlint ${lintDirs.join(" ")} --fix`);
}