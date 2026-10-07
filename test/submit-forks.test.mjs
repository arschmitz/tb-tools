import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createGraphSubmitSession } from "../commands/graph/actions.mjs";
import { run } from "../lib/utils.mjs";

const exec = promisify(execFile);

for (const uneven of [false, true]) {
  for (const amended of [false, true]) {
    test(`submit preserves ${uneven ? "unequal" : "equal"} forks when upload ${amended ? "amends" : "keeps"} the commit`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "tb-submit-forks-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
      const commit = async (name) => {
        await writeFile(path.join(root, `${name}.txt`), `${name}\n`);
        await git("add", ".");
        await git("commit", "-m", name);
        return git("rev-parse", "HEAD");
      };
      await git("init", "-b", "main");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.com");
      await git("config", "commit.gpgsign", "false");
      await commit("base");
      await git("update-ref", "refs/remotes/origin/main", "HEAD");
      await git("switch", "-c", "Bug-parent");
      const original = await commit("parent");
      await git("branch", "Bug-parent-alias");
      await git("switch", "-c", "Bug-a");
      await commit("a");
      await git("branch", "Bug-a-alias");
      if (uneven) {
        await commit("a-tip");
      }
      await git("switch", "-c", "Bug-b", "Bug-parent");
      await commit("b");
      await git("switch", "Bug-parent");
      let uploads = 0;
      const session = createGraphSubmitSession({
        graph: { path: root, label: "comm", branch: "Bug-parent" },
        getSnapshot: async () => ({}),
        runCommand: async (command) => {
          if (command.cmd === "moz-phab") {
            uploads++;
            if (amended) {
              await git("commit", "--amend", "-m", "Parent submitted\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456");
            }
            return "Submitted https://phabricator.services.mozilla.com/D123456\n";
          }
          assert.equal(command.cmd, "git");
          return run(command);
        },
        postComment: async () => assert.fail("Unexpected remote comment"),
      });
      const deadline = Date.now() + 20000;
      while (!["complete", "error", "canceled"].includes(session.status) && Date.now() < deadline) {
        if (session.prompt) {
          session.answer(session.prompt.id, false);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(session.status, "complete", session.error || session.output);
      assert.equal(uploads, 1);
      const parent = await git("rev-parse", "Bug-parent");
      assert.equal(parent === original, !amended);
      assert.equal(await git("rev-parse", "Bug-parent-alias"), parent);
      assert.equal(await git("rev-parse", "Bug-a-alias^"), parent);
      assert.equal(await git("rev-parse", "Bug-b^"), parent);
      if (uneven) {
        assert.equal(await git("rev-parse", "Bug-a^"), await git("rev-parse", "Bug-a-alias"));
      }
      assert.equal(await git("show", "Bug-a:a.txt"), "a");
      assert.equal(await git("show", "Bug-b:b.txt"), "b");
      await assert.rejects(git("cat-file", "-e", "Bug-b:a.txt"));
      await assert.rejects(git("cat-file", "-e", "Bug-a:b.txt"));
      assert.equal(await git("branch", "--show-current"), "Bug-parent");
      assert.equal(await git("status", "--porcelain"), "");
    });
  }
}
