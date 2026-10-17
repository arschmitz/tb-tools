import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyPackagedVectorSearch } from '../desktop/package.mjs';

async function fixture(t, platform, arch) {
  const resources = await mkdtemp(path.join(tmpdir(), 'knowledge-vector-package-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const target = platform === 'darwin' ? 'darwin-arm64+x64' : `${platform}-${arch}`;
  const binary = path.join(resources, 'app.asar.unpacked', 'node_modules', 'usearch', 'prebuilds', target, 'usearch.node');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'isolated packaging manifest fixture');
  return resources;
}

test('packaged native validation uses the shipped standalone Node and unpacked application', { skip: process.platform === 'win32' && process.arch === 'arm64' }, async t => {
  const resources = await fixture(t, process.platform, process.arch);
  const calls = [];
  const result = await verifyPackagedVectorSearch(resources, { platform: process.platform, arch: process.arch,
    execute: async (...args) => { calls.push(args); } });
  assert.deepEqual(result, { supported: true, executed: true }, 'The current supported target should execute its native vector smoke check.');
  assert.equal(calls.length, 1, 'The current target should launch one standalone Node check.');
  const [command, args, options] = calls[0];
  assert.equal(command, path.join(resources, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node'), 'Validation should use the packaged standalone Node executable.');
  assert.equal(options.cwd, path.join(resources, 'app.asar.unpacked'), 'Native imports should resolve inside the unpacked shipped application.');
  assert.deepEqual(args.slice(0, 2), ['--input-type=module', '--eval'], 'The packaged runtime should evaluate a native module smoke program.');
  assert.match(args[2], /index\.search\(vector, 1\)/, 'The smoke program should execute an indexed nearest-neighbor query.');
  assert.match(args[2], /dimensions: 384/, 'The smoke program should exercise the production embedding dimension.');
  assert.match(args[2], /mapped\.view\(process\.argv\[1\]\)/, 'The smoke program should verify a saved immutable graph through the mapped reader API.');
  await assert.rejects(access(path.dirname(args[3])), { code: 'ENOENT' }, 'The parent should remove smoke graph files after the child exits.');
});

test('cross-target packages require their own binary without executing a foreign Node runtime', async t => {
  const platform = process.platform === 'linux' ? 'darwin' : 'linux';
  const resources = await fixture(t, platform, 'x64');
  const result = await verifyPackagedVectorSearch(resources, { platform, arch: 'x64', execute: async () => assert.fail('Cross-target validation should not execute a foreign binary.') });
  assert.deepEqual(result, { supported: true, executed: false }, 'A cross-target package should validate binary presence without host execution.');
  await rm(path.join(resources, 'app.asar.unpacked', 'node_modules', 'usearch'), { recursive: true });
  await assert.rejects(verifyPackagedVectorSearch(resources, { platform, arch: 'x64' }), { code: 'ENOENT' }, 'A missing target binary should fail package validation.');
});

test('unsupported Windows ARM64 packages retain the explicit exact-search fallback', async () => {
  const result = await verifyPackagedVectorSearch('/unused-fixture', { platform: 'win32', arch: 'arm64', execute: async () => assert.fail('An unsupported target should not attempt native execution.') });
  assert.deepEqual(result, { supported: false }, 'A target without a published native binary should report unsupported indexing.');
});


test('a failed packaged native smoke removes its temporary graph files', { skip: process.platform === 'win32' && process.arch === 'arm64' }, async t => {
  const resources = await fixture(t, process.platform, process.arch);
  let file;
  await assert.rejects(verifyPackagedVectorSearch(resources, { platform: process.platform, arch: process.arch,
    execute: async (_command, args) => { file = args[3]; await writeFile(file, 'partial graph'); throw new Error('Native smoke failed.'); } }),
  /Native smoke failed/, 'A failed native smoke should fail packaging.');
  await assert.rejects(access(path.dirname(file)), { code: 'ENOENT' }, 'Failed smoke graphs should be removed after the child returns.');
});
