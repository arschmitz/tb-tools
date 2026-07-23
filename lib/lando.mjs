import config from "./config.mjs";
import { run } from "./utils.mjs";

export const DEFAULT_LANDO_REPO = "thunderbird-desktop-main";

export function getDefaultLandoRepo() {
  return config.lando?.repo || DEFAULT_LANDO_REPO;
}

export async function pushCommits({
  landoRepo = getDefaultLandoRepo(),
  localRepo = process.cwd(),
  branch,
  relbranch,
  baseCommit,
  yes = false,
} = {}) {
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
