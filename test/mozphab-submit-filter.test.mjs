import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execute = promisify(execFile);
test("moz-phab filters outgoing descriptions and diff messages without changing local text", async () => {
  await execute("python3", [fileURLToPath(new URL("./mozphab-submit-filter.test.py", import.meta.url))]);
});
