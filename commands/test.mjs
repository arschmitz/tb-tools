import path from "path";
import { getChangedFilePaths } from "../lib/git.mjs";
import { mach } from "../lib/utils.mjs";

export default async function testChanged({ flavor = "all" } = {}) {
  const files = await getChangedFilePaths();

  const tests = files.reduce((collection, item) => {
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

  if (!tests.size) {
    return;
  }

  await mach(["test", ...Array.from(tests)].join(" "));
}
