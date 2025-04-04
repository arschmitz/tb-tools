import path from "path";
import { hg } from "../lib/hg.mjs";
import { mach } from "../lib/utils.mjs";

export default async function testChanged({ type = "all" } = {}) {
  const files = (await hg("status --change .", undefined, true)).split(/\n/);
  const dirtyFiles = (await hg("status -mard", undefined, true)).split(/\n/);

  const tests = [...files, ...dirtyFiles].reduce((collection, item) => {
    item = item.slice(2);
    if (!item) {
      return collection;
    }

    if (!/components/.test(item)) {
      collection.add(item);
      return collection;
    }

    const componentPath = item.split("components")[1];
    const name = componentPath.split(path.sep)[1];

    if (name === "storybook") {
      return collection;
    }

    let _path = `${path.join("mail", "components", name)}`
    if (type !== "all") {
      _path = path.join(_path, "test", type)
    }

    collection.add(_path);

    return collection;
  }, new Set());

  await mach(["test", ...Array.from(tests)].join(" "));
}