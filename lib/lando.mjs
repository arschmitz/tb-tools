import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import config from "./config.mjs";
import { run } from "./utils.mjs";

export const DEFAULT_LANDO_REPO = "thunderbird-desktop-main";
export const DEFAULT_LANDO_CONFIG_PATH = path.join(
  os.homedir(),
  ".mozbuild",
  "lando.toml",
);

function getTomlAuthValue(contents, name) {
  let inAuthSection = false;

  for (const line of String(contents || "").split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);

    if (section) {
      inAuthSection = section[1].trim() === "auth";
      continue;
    }

    if (!inAuthSection) {
      continue;
    }

    const entry = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));

    if (!entry) {
      continue;
    }

    const value = entry[1].trim();
    const basicString = value.match(/^"((?:\\.|[^"\\])*)"(?:\s*#.*)?$/);
    const literalString = value.match(/^'([^']*)'(?:\s*#.*)?$/);

    if (basicString || literalString) {
      return {
        hasValue: true,
        valid: true,
        value: (basicString || literalString)[1].trim(),
      };
    }

    return {
      hasValue: Boolean(value),
      valid: false,
      value: "",
    };
  }

  return {
    hasValue: false,
    valid: true,
    value: "",
  };
}

export async function getLandoConfigurationStatus({
  env = process.env,
  homeDirectory = os.homedir(),
  readConfig = readFile,
} = {}) {
  const configPath = env.LANDO_CONFIG_PATH || path.join(
    homeDirectory,
    ".mozbuild",
    "lando.toml",
  );
  let contents = "";

  try {
    contents = await readConfig(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const environmentApiToken = String(env.LANDO_HEADLESS_API_TOKEN || "").trim();
  const environmentUserEmail = String(env.LANDO_USER_EMAIL || "").trim();
  const configApiToken = getTomlAuthValue(contents, "api_token");
  const configUserEmail = getTomlAuthValue(contents, "user_email");
  const apiToken = environmentApiToken || configApiToken.value;
  const userEmail = environmentUserEmail || configUserEmail.value;
  const missing = [];
  const invalid = [];

  if (!apiToken) {
    missing.push("api_token");
  }

  if (!userEmail) {
    missing.push("user_email");
  }

  if (!environmentApiToken && configApiToken.hasValue && !configApiToken.valid) {
    invalid.push("api_token");
  }

  if (!environmentUserEmail && configUserEmail.hasValue && !configUserEmail.valid) {
    invalid.push("user_email");
  }

  return {
    configPath,
    configured: !missing.length && !invalid.length,
    invalid,
    missing,
  };
}

export async function assertLandoConfigured(options = {}) {
  const status = await getLandoConfigurationStatus(options);

  if (status.configured) {
    return status;
  }

  const problems = [
    ...status.missing.map((name) => `missing ${name}`),
    ...status.invalid.map((name) => `${name} must be a quoted TOML string`),
  ];

  const error = new Error(
    `Lando is not configured: ${problems.join("; ")}. ` +
    `Add quoted [auth] api_token and user_email values to ${status.configPath}, ` +
    "or set LANDO_HEADLESS_API_TOKEN and LANDO_USER_EMAIL.",
  );

  error.code = "LANDO_AUTH_CONFIG_MISSING";
  error.statusCode = 400;
  throw error;
}

export function getDefaultLandoRepo() {
  return config?.lando?.repo || DEFAULT_LANDO_REPO;
}

export async function pushCommits({
  landoRepo = getDefaultLandoRepo(),
  localRepo = process.cwd(),
  branch,
  relbranch,
  baseCommit,
  yes = false,
} = {}) {
  await assertLandoConfigured();

  const args = [
    "push-commits",
    "--local-repo",
    localRepo,
    "--lando-repo",
    landoRepo,
  ];

  if (branch) {
    args.push("--branch", branch);
  }

  if (relbranch) {
    args.push("--relbranch", relbranch);
  }

  if (baseCommit) {
    args.push("--base-commit", baseCommit);
  }

  if (yes) {
    args.push("--yes");
  }

  return run({ cmd: "lando", args, capture: true });
}
