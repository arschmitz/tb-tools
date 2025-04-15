import rustCheck from "./rust-check.mjs";
import { mach } from "../lib/utils.mjs";

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
    await mach("build");
  }

  if (run) {
    await mach("run");
  }
}