import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialStatus, saveCredentials } from "../desktop/setup-credentials.cjs";
import { configuredCheckout, rememberCheckout, writeJson } from "../desktop/setup-store.cjs";
import { chooseCheckout } from "../desktop/setup.cjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-setup-keys-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "settings.json") };
}

test("credentials use runtime fields, preserve settings, and never return saved keys", t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ ai: { provider: "keep" }, phabricator: { extra: true }, bugzilla: { url: "keep" } }));
  saveCredentials(file, { phabricatorUser: " test-user ", phabricatorToken: "api-test-secret", bugzillaKey: "bugzilla-test-secret" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    ai: { provider: "keep" }, phabricator: { extra: true, user: "test-user", token: "api-test-secret" },
    bugzilla: { url: "keep", apiKey: "bugzilla-test-secret" },
  }, "Saving credentials should merge the exact fields used by the runtime.");
  assert.deepEqual(credentialStatus(file), { phabricatorUser: "test-user", hasPhabricatorToken: true, hasBugzillaKey: true },
    "The renderer should receive the username and saved-state flags without saved secrets.");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600,
    "The credentials file should be readable and writable only by its owner.");
  saveCredentials(file, { phabricatorUser: "test-user", phabricatorToken: "", bugzillaKey: "new-bugzilla-secret" });
  const changed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(changed.phabricator.token, "api-test-secret", "A blank field should keep the existing Phabricator token.");
  assert.equal(changed.bugzilla.apiKey, "new-bugzilla-secret", "A new key should replace only that service's key.");
});

test("invalid settings and input leave existing configuration unchanged", t => {
  const { file } = fixture(t);
  for (const contents of ["{", "[]", "null", '{"phabricator":[]}', '{"bugzilla":"invalid"}']) {
    fs.writeFileSync(file, contents);
    assert.throws(() => saveCredentials(file, { bugzillaKey: "fake-key" }), /existing .tb.json/,
      "Malformed settings should stop saving before any file is replaced.");
    assert.equal(fs.readFileSync(file, "utf8"), contents, "Malformed settings should be preserved byte for byte.");
    assert.ok(credentialStatus(file).error, "Malformed settings should provide an actionable error without their contents.");
  }
  fs.writeFileSync(file, "{}");
  assert.throws(() => saveCredentials(file, { phabricatorToken: "api-fake-secret" }), /both your Phabricator/,
    "A Phabricator token should require a username.");
  assert.throws(() => saveCredentials(file, { bugzillaKey: "secret\nsecond-line" }), /single line/,
    "Multiline keys should be rejected without echoing their contents.");
  assert.equal(fs.readFileSync(file, "utf8"), "{}", "Invalid input should leave the settings unchanged.");
});

test("completed credentials setup survives explicit checkout launches", async t => {
  const { root, file } = fixture(t);
  const comm = path.join(root, "source", "comm");
  fs.mkdirSync(path.join(comm, ".git"), { recursive: true });
  fs.mkdirSync(path.join(comm, "mail", "config"), { recursive: true });
  fs.writeFileSync(path.join(comm, "mail", "config", "version.txt"), "1");
  fs.writeFileSync(path.join(root, "source", "mach"), "");
  const userData = path.join(root, "app");
  writeJson(path.join(userData, "checkout.json"), { commPath: comm, credentialsSetupComplete: true });
  assert.equal(configuredCheckout({ userData, option: comm, env: {} }), comm, "An explicit checkout should retain its saved setup state.");
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "checkout.json"), "utf8")).credentialsSetupComplete, true,
    "An explicit launch should preserve the credentials completion marker.");
  const result = await chooseCheckout({ app: { getPath: () => userData }, configFile: file, env: {},
    BrowserWindow: class { constructor() { assert.fail("Completed setup should not open another credentials window."); } } });
  assert.equal(result, comm, "A completed checkout should open directly even when keys were skipped.");
  rememberCheckout(userData, comm);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "checkout.json"), "utf8")).credentialsSetupComplete, true,
    "Remembering the same checkout should keep credentials completion.");
});
