import { mach } from "../lib/utils.mjs";
import ora from "ora";

const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];

export default async function lint() {
  const lintSpinner = ora({
    text: `Linting`,
    spinner: "aesthetic"
  }).start();
  try {
    await mach(`commlint ${lintDirs.join(" ")} --fix`);
    lintSpinner.succeed();
  } catch (error) {
    lintSpinner.fail();
    throw error;
  }
}