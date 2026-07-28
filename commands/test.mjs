import path from "path";
import { getChangedFilePaths } from "../lib/git.mjs";
import { mach } from "../lib/utils.mjs";

export function getTestsForChangedFiles(files, { flavor = "all" } = {}) {
  return files.reduce((collection, item) => {
    if (!item) {
      return collection;
    }

    const fileName = path.basename(item);

    if (/^(test_|browser_)/.test(fileName)) {
      collection.add(item);
      return collection;
    }

    if (!/components/.test(item)) {
      return collection;
    }

    const componentPath = item.split("components")[1];
    const name = componentPath.split(path.sep)[1];

    if (/js/.test(name)) {
      return collection;
    }

    if (name === "storybook") {
      return collection;
    }

    let _path = `${path.join("mail", "components", name)}`;
    if (flavor !== "all") {
      _path = path.join(_path, "test", flavor);
    }

    collection.add(_path);

    return collection;
  }, new Set());
}

export function getPatterns(pattern) {
  if (!pattern) {
    return [];
  }

  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.filter(Boolean);
}

export async function getTestTargets({
  flavor = "all",
  pattern,
  getChangedFiles = getChangedFilePaths,
} = {}) {
  const patterns = getPatterns(pattern);

  if (patterns.length) {
    return patterns;
  }

  const files = await getChangedFiles();

  return Array.from(getTestsForChangedFiles(files, { flavor }));
}

export function createTestCommand({
  getChangedFiles = getChangedFilePaths,
  runMach = mach,
} = {}) {
  return async function testChanged({ flavor = "all", pattern, headless = false } = {}) {
    const targets = await getTestTargets({ flavor, pattern, getChangedFiles });

    if (!targets.length) {
      return;
    }

    await runMach(["test", ...(headless ? ["--headless"] : []), ...targets]);
  };
}

export default createTestCommand();
