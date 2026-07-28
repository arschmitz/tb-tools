import diffCommand from "./diff.mjs";
import lint from "./lint.mjs";
import statusCommand from "./status.mjs";
import testChanged from "./test.mjs";
import tryCommand from "./try.mjs";

export function getPreflightSteps({
  skipLint = false,
  skipTest = false,
  diff = false,
  try: runTry = false,
} = {}) {
  const steps = ["status"];

  if (!skipLint) {
    steps.push("lint");
  }

  if (!skipTest) {
    steps.push("test");
  }

  if (diff) {
    steps.push("diff");
  }

  if (runTry) {
    steps.push("try");
  }

  return steps;
}

export function getTestOptions(options) {
  return {
    flavor: options.flavor,
    pattern: options.pattern,
    headless: options.headless,
  };
}

export function getTryOptions(options) {
  return {
    selector: options.selector,
    query: options.query,
    "tasks-regex": options["tasks-regex"],
    preset: options.preset,
    artifact: options.artifact,
    comment: options.comment,
  };
}

export function createPreflightCommand({
  status = statusCommand,
  lintCommand = lint,
  testCommand = testChanged,
  diff = diffCommand,
  tryRunner = tryCommand,
  write = console.log,
} = {}) {
  return async function preflight(options = {}) {
    const steps = getPreflightSteps(options);

    for (const step of steps) {
      write(`Running ${step}`);

      if (step === "status") {
        await status({ base: options.base });
      } else if (step === "lint") {
        await lintCommand();
      } else if (step === "test") {
        await testCommand(getTestOptions(options));
      } else if (step === "diff") {
        await diff(options.diffArgs || []);
      } else if (step === "try") {
        await tryRunner(getTryOptions(options));
      }
    }
  };
}

export default createPreflightCommand();
