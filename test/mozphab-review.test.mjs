import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("review stack preserves case-only renames and dependent changes", async () => {
  await promisify(execFile)("python3", [fileURLToPath(new URL("./mozphab-review.test.py", import.meta.url))]);
});
