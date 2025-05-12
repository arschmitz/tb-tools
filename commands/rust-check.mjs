import ora from "ora";
import phab from "../lib/phab.mjs";
import { hg, pullUp } from "../lib/hg.mjs";
import { mach, run } from "../lib/utils.mjs";

export default async function (update) {
  await hg("bookmark -f -r . checkpoint", "..");
  await pullUp("central");
  let error = await runRust();
  let commUpdated = false;

  await hg("bookmark -f -r . rust-checkpoint");
  const spinner = ora({
    text: "Checking comm for updates"
  }).start();

  if (error) {
    await pullUp("comm");
    commUpdated = true;
    error = await runRust();
  }

  if (error) {
    spinner.text = "Checking phab for rust update patches"

    const response = await phab({ route: "differential.query", params: { authors: ["PHID-USER-3zyedh2kyrzsg5v6bc4p"], status: "status-open" } });
    if (response.result.length) {
      spinner.succeed();
      await pullUp("comm");
      commUpdated = true;
      error = await runRust();

      if (error) {
        await hg("up rust-checkpoint", undefined, true);

        const patchSpinner = ora({
          text: "Landing rust patch"
        }).start();
        try {
          await run({ cmd: "moz-phab", args:["patch", `D${response.result[0].id}`, "--no-bookmark", "--skip-dependencies", "--apply-to", "."], capture: true, silent: true });
          patchSpinner.succeed();
          error = false;
        } catch {
          patchSpinner.fail();
        }
        error = await runRust();
      }
    }

    if (error) {
      spinner.fail();
      console.info(`❌ Rust updates required and not found`);
      process.exit(1);
    } else {
      spinner.succeed();
    }
  } else {
    spinner.succeed();
  }

  if (!update || error) {
    await hg("up checkpoint", "..", true);
    await hg("up rust-checkpoint", undefined, true);
  } else if (!commUpdated) {
    await pullUp("comm");
  }

  if (error) {
    throw error;
  }
}

async function runRust() {
  const spinner = ora({
    text: "Checking Rust Dependencies"
  }).start();
  let error;
  try {
    await mach("tb-rust check-upstream", true);
    spinner.succeed();
  } catch {
    spinner.fail();
    error = true;
  }

  return error;
}