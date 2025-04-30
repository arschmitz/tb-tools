import rustCheck from "./rust-check.mjs";
import { mach, machBuild } from "../lib/utils.mjs";

export default async function update({ build = false, run = false, force = false } = {}) {
  try {
    await rustCheck(true);
  } catch (error) {
    if (!force) {
      console.error(error);
      return;
    }
  }

  if (build || run) {
    await machBuild();
  }

  if (run) {
    await mach("run");
  }
}