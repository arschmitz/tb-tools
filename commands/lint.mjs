import { mach } from "../lib/utils.mjs";

const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];

export default async function lint() {
  return mach(`commlint ${lintDirs.join(" ")} --fix`);
}