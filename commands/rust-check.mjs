import ora from "ora";
import { hg, pullUp } from "../lib/hg.mjs";
import { mach } from "../lib/utils.mjs";

export default async function () {
  await hg("bookmark -f -r . checkpoint", "..");
  await pullUp("central");
  const spinner = ora({
    text: "Checking Rust Dependencies"
  }).start();
  let error;
  try {
    await mach("tb-rust check-upstream", true);
    spinner.succeed();
  } catch (_error) {
    spinner.fail();
    error = _error;
  }
  await hg("up checkpoint", "..", true);

  if (error) {
    throw error;
  }
}