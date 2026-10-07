import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../lib/utils.mjs";

const roots = process.argv.slice(2).map(root => path.resolve(root));
assert.equal(roots.length, 2, "Pass two Gecko worktree roots");
const cache = path.join(process.env.TB_BUILD_CACHE_PATH || path.join(os.homedir(), ".tb-tools", "build-cache"), "compiler");
const sccache = path.join(os.homedir(), ".mozbuild", "sccache", process.platform === "win32" ? "sccache.exe" : "sccache");
const stats = [];
for (let index = 0; index < roots.length; index++) {
  const root = roots[index];
  const directory = path.join(root, "obj-task", "cache-probe");
  await mkdir(directory, { recursive: true });
  const source = path.join(directory, "probe.c");
  const header = path.join(directory, "value.h");
  await writeFile(source, '#include "value.h"\nint tb_cache_answer(void) { return TB_CACHE_VALUE; }\n');
  await writeFile(header, "#define TB_CACHE_VALUE 73019\n");
  const env = { SCCACHE_DIR: cache, SCCACHE_BASEDIRS: root, SCCACHE_DIRECT: "false",
    SCCACHE_IDLE_TIMEOUT: "120", ...(process.platform === "win32"
      ? { SCCACHE_SERVER_PORT: String(20000 + (process.pid + index) % 40000) }
      : { SCCACHE_SERVER_UDS: path.join(os.tmpdir(), `tb-cache-probe-${process.pid}-${index}.sock`) }) };
  const command = args => run({ cmd: sccache, args, cwd: root, env, capture: true, silent: true });
  try {
    await command(["--start-server"]);
    await command([process.env.TB_CACHE_SMOKE_COMPILER || "clang", "-c", source, "-o", path.join(directory, "probe.o")]);
    const initial = JSON.parse(await command(["--show-stats", "--stats-format=json"]));
    await writeFile(path.join(os.tmpdir(), `commands-cache-probe-${index}-initial.json`), JSON.stringify(initial,null,2));
    const hits = Object.values(initial.stats.cache_hits.counts).reduce((total, value) => total + value, 0);
    if (index === 1) assert.ok(hits >= 1, "The second root must get a compiler cache hit");
    // A changed header must produce a miss, even though the first root stays unchanged.
    await writeFile(header, `#define TB_CACHE_VALUE ${73021 + index + process.pid}\n`);
    await command([process.env.TB_CACHE_SMOKE_COMPILER || "clang", "-c", source, "-o", path.join(directory, "changed.o")]);
    const final = JSON.parse(await command(["--show-stats", "--stats-format=json"]));
    await writeFile(path.join(os.tmpdir(), `commands-cache-probe-${index}-final.json`), JSON.stringify(final,null,2));
    const misses = counts => Object.values(counts).reduce((total, value) => total + value, 0);
    assert.ok(misses(final.stats.cache_misses.counts) > misses(initial.stats.cache_misses.counts));
    stats.push({ root, cache, hits, changedHeaderMiss: true });
  } finally { await command(["--stop-server"]).catch(() => {}); }
}
await writeFile(path.join(os.tmpdir(), "commands-compiler-cache-smoke.json"), `${JSON.stringify(stats, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, stats }));
