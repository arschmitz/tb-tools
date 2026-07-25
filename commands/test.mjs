import path from "path";
import { getChangedFilePaths } from "../lib/git.mjs";
import { mach } from "../lib/utils.mjs";

export function getTestsForChangedFiles(files, { flavor = "all" } = {}) {
  return files.reduce((collection, item) => {
    if (!item) {
      return collection;
    }

    if (!/components/.test(item)) {
      if (/^test_|^browser_/.test(item)) {
        collection.add(item);
      }
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

    let _path = `${path.join("mail", "components", name)}`
    if (flavor !== "all") {
      _path = path.join(_path, "test", flavor)
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

export function createTestCommand({
  getChangedFiles = getChangedFilePaths,
  runMach = mach,
} = {}) {
  return async function testChanged({ flavor = "all", pattern } = {}) {
    const patterns = getPatterns(pattern);

    if (patterns.length) {
      await runMach(["test", ...patterns]);
      return;
    }

    const files = await getChangedFiles();
    const tests = getTestsForChangedFiles(files, { flavor });

    if (!tests.size) {
      return;
    }

    await runMach(["test", ...Array.from(tests)]);
  };
}

export default createTestCommand();
