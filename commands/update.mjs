import rustCheck from "./rust-check.mjs";
import { mach } from "../lib/utils.mjs";
import { hg, pullUp } from "../lib/hg.mjs";

export default async function update({ build = false, run = false, force = false } = {}) {
  try {
    await rustCheck();
  } catch (error) {
    if (!force) {
      console.error(error);
      return;
    }
  }
  await hg("up central", "..", true);
  await pullUp();

  if (build || run) {
    await mach("build");
  }

  if (run) {
    await mach("run");
  }
}