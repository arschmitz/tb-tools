import { mach } from "../lib/utils.mjs";
import { pullUp } from "../lib/hg.mjs";

export default async function update({ build = false, run = false } = {}) {
  try {
    await pullUp("central");
    await pullUp();
    await mach("tb-rust check-upstream");

    if (build || run) {
      await mach("build");
    }

    if (run) {
      await mach("run");
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}