import ora from "ora";
import phab from "../lib/phab.mjs";
import { createCheckpoint, restoreCheckpoint, pullUp } from "../lib/git.mjs";
import { mach, run } from "../lib/utils.mjs";

export default async function (update) {
  const firefoxCheckpoint = await createCheckpoint("checkpoint", "..");
  await pullUp("central");
  let error = await runRust();
  let commUpdated = false;

  const commCheckpoint = await createCheckpoint("rust-checkpoint");
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
        await restoreCheckpoint(commCheckpoint);

        const patchSpinner = ora({
          text: "Landing rust patch"
        }).start();
        try {
          await run({ cmd: "moz-phab", args:["patch", `D${response.result[0].id}`, "--skip-dependencies", "--apply-to", "here"], capture: true, silent: true });
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
      error = new Error("Rust updates required and not found");
    } else {
      spinner.succeed();
    }
  } else {
    spinner.succeed();
  }

  if (!update || error) {
    await restoreCheckpoint(firefoxCheckpoint, "..");
    await restoreCheckpoint(commCheckpoint);
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
