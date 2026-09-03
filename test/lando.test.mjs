import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLandoConfigured,
  getLandoConfigurationStatus,
} from "../lib/lando.mjs";

test("getLandoConfigurationStatus reads Lando auth from its config file", async () => {
  const status = await getLandoConfigurationStatus({
    env: {},
    homeDirectory: "/home/tester",
    readConfig: async () => [
      "[auth]",
      'api_token = "test-token"',
      'user_email = "tester@mozilla.com"',
    ].join("\n"),
  });

  assert.deepEqual(status, {
    configPath: "/home/tester/.mozbuild/lando.toml",
    configured: true,
    invalid: [],
    missing: [],
  });
});

test("getLandoConfigurationStatus rejects unquoted TOML credentials", async () => {
  const status = await getLandoConfigurationStatus({
    env: {},
    homeDirectory: "/home/tester",
    readConfig: async () => [
      "[auth]",
      "api_token = test-token",
      'user_email = "tester@mozilla.com"',
    ].join("\n"),
  });

  assert.deepEqual(status, {
    configPath: "/home/tester/.mozbuild/lando.toml",
    configured: false,
    invalid: ["api_token"],
    missing: ["api_token"],
  });
});

test("assertLandoConfigured reports the missing headless credentials", async () => {
  await assert.rejects(
    assertLandoConfigured({
      env: {},
      homeDirectory: "/home/tester",
      readConfig: async () => {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, "LANDO_AUTH_CONFIG_MISSING");
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /missing api_token; missing user_email/);
      assert.match(error.message, /\/home\/tester\/\.mozbuild\/lando\.toml/);
      return true;
    },
  );
});
