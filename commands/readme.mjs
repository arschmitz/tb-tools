import fs from "fs";
import banner from "../lib/banner.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const consoleScreenshots = [
  {
    path: "/images/console-overview.png",
    alt: "Thunderbird Desktop Console showing a selected commit, integration badges, and a GitHub-style diff",
    caption:
      "The main console view keeps the comm graph, checkout state, Bugzilla and Phabricator status, tracked try runs, and a syntax-highlighted diff in one place.",
  },
  {
    path: "/images/console-try.png",
    alt: "Thunderbird Desktop Console try run dialog",
    caption:
      "The try dialog exposes the normal `mach try` selectors, presets, task regexes, artifact builds, and optional Phabricator comments without leaving the browser flow.",
  },
  {
    path: "/images/console-land.png",
    alt: "Thunderbird Desktop Console land patches dialog",
    caption:
      "The Land Patches flow brings the `tb land` sheriff workflow into the console, showing accepted checkin-needed patches, related links, prompts, and Lando output.",
  },
  {
    path: "/images/console-test-output.png",
    alt: "Thunderbird Desktop Console parsed test output",
    caption:
      "Test runs preserve colored output and add parsed summaries, failed-file actions, rerun controls, copy buttons, and VS Code links.",
  },
];

function pushConsoleSection(lines) {
  lines.push(
    "## Thunderbird Desktop Console",
    "",
    "`tb console` starts a local browser-based control surface for Thunderbird patch work. The standalone desktop app runs the same console in a persistent window and creates its own Review worktrees. See the desktop app section below.",
    "",
    "Use the console to:",
    "",
    "- switch between Working and Review checkout modes while keeping a single comm and Firefox graph tab, with the current checkout, uncommitted changes, branch labels, and tracked try runs",
    "- click commits for full commit messages, Bugzilla, Phabricator, and linked Notion story badges, integration status, change totals, and GitHub-style syntax-highlighted diffs",
    "- authenticate with Phabricator from the menu to display native inline code suggestions alongside reviewed diffs, including suggestions that also have prose comments",
    "- create commits with Bug branch detection, a bug-number fallback, Phabricator-backed reviewer and review-group autocomplete, blocking-review toggles, and a durable `TB-Tools-Id` trailer for console metadata",
    "- checkout, rebase, interactively reorder/squash/fixup/drop local commit ranges, prune, amend, submit, and mark accepted patches with `checkin-needed-tb` from the selected commit",
    "- keep console AI chats in the **TB Console** sidebar section. Each successful AI turn is archived after its result is saved by Codex; failed and interrupted turns stay visible. The console keeps its results and automatically restores the same chat when you resume or send a follow-up. Archiving does not delete conversation history",
    "- use **Update** for a freeform conversation about your patch. It loads the newest local patch and review history in the Working checkout, shows the current patch or pending changes beside the conversation, and lets you request more edits, amend, submit, or roll back the local patch to the start of the session. It has its own saved chat and does not post review comments",
    "- use **Verify** beside **Review Update** on patch cards and selected commits. Verify reviews your newest local copy (by Git commit time) in the Working comm checkout, with the same defect and accessibility checks as Review plus CodeRabbit. Address findings one at a time, preview each change, amend or revert it, then submit. Verify does not post review comments. Review Update handles reviewer feedback. Each flow has its own saved session",
    "- copy a selected commit or local stack between the Working and Review checkout pairs on a new destination branch, with an atomic rollback if cherry-picking fails",
    "- use artifact builds and `build faster` for frontend-only comm changes; use a normal build for native or Firefox changes",
    "- reuse completed binary snapshots from `~/.tb-tools/build-cache` and the shared mach download cache; keep each checkout's writable object directory separate",
    "- sync Review source to the Working commits while keeping private worktree builds intact",
    "- choose whether Pull or Rebase acts on the selected checkout pair or both pairs; build/run, lint, test, pull patch, and try follow the selected comm tab",
    "- pull both repositories, rebase a local stack, build, run, lint, pull patches, create patches, start try runs, and land checkin-needed patches",
    "- run modified tests or explicit path/glob patterns, including headless runs, with parsed final summaries and rerun actions for failures",
    "- create persistent Meta Bug boards: group dependent stories by child meta bug, filter by assignee or child meta, update story fields in place, and open linked bugs internally or in Bugzilla",
    "- create Bugzilla-backed sprints from a Meta Bug board, roll open stories forward while closing the prior sprint, plan source stories in four point-totalled columns, and track dates, burndown, and assigned-point totals",
    "- watch command progress in a slim status bar with elapsed time, cancellable running work, and toggleable output",
    "- monitor comm and Firefox `origin/main` freshness plus Rust dependency sync warnings before remote-build workflows like try and submit",
    "- close console browser tabs automatically when the local console process exits, with an opt-out for keeping tabs open",
    "",
    "AI tasks use automatic local knowledge capture and bounded retrieval. See [Console knowledge](docs/knowledge.md) for learning budgets, private records, Git sync, and inspection commands.",
    "",
  );

  for (const screenshot of consoleScreenshots) {
    lines.push(
      `![${screenshot.alt}](${screenshot.path})`,
      "",
      `_${screenshot.caption}_`,
      "",
    );
  }
}

function pushDesktopSection(lines) {
  lines.push(
    "## Standalone desktop app",
    "",
    "Run `npm ci`, then `npm run desktop -- --comm=/path/to/firefox/comm`. Run `npm run desktop:package` to make a native app for the current system. The app keeps running in the tray after its console window closes. Links open in app-owned windows. Pages from the same site reuse a window. The Pages menu can go back, go forward, reload, or close those windows.",
    "",
    "The desktop app creates paired Review worktrees in `~/.tb-tools/worktrees`. Each revision under review gets its own pair, so different reviews can run together. Each active worktree has its own writable object directory. Completed artifact snapshots live in `~/.tb-tools/build-cache`. When sccache is installed, its compiler-result storage is shared; cache hits across worktrees depend on the active sccache server's base paths. The app turns off sccache direct mode to avoid stale headers across worktrees. A new worktree can build without copying another live object directory. Try repair worktrees also get a Thunderbird build config with a private object directory. Windows builds need Visual Studio C++ tools, MozillaBuild's `bin` directory on PATH, and native Python.",
    "",
    "In Settings, set one or more local times in `HH:MM` format and enable Daily source pull and build. The app fetches both `origin/main` branches, updates its own detached worktree in `~/.tb-tools/daily-build`, and runs `./mach build` there. It never switches the Working checkout. Build now, Cancel build, and View log are available in the same section. If the app starts after a scheduled time, it runs one catch-up build that day. Enabling the schedule also asks the packaged app to start at login on macOS or Windows; operating system approval may still be needed.",
    "",
    "For phone access over cellular, install Tailscale on the computer and phone and sign in to the same private network. Choose Pair Phone in the desktop app. It configures Tailscale Serve on private HTTPS port 8443 and shows the phone URL and a one-time code. Open the URL on the phone, enter the code, then add the page to the home screen. The phone uses the same console and actions through a separate paired gateway. Disable Phone Access and Revoke Paired Phones are in the app menu. The original local console stays bound to loopback.",
    "",
  );
}

export function formatDefaultValue(value) {
  return value === undefined ? "" : String(value);
}

export function formatOptionExample(command, option) {
  const value = option.exampleValue ?? option.defaultValue;

  if (value === undefined) {
    return `tb ${command} --${option.name}=<value>`;
  }

  if (value === true || value === "true") {
    return `tb ${command} --${option.name}=false`;
  }

  if (value === false || value === "false") {
    return `tb ${command} --${option.name}`;
  }

  return `tb ${command} --${option.name}=${value}`;
}

export default async function (optionList, subOptions) {
  const lines = [
    "<!-- this file is automatically generated do not edit -->",
    "# TB Tools - Thunderbird Development Console and CLI Tools",
    "Simplify tasks related to developing thunderbird.",
    "",
    "Right now these are only things that I have personally used and found useful but happy to add more.",
    "## Installation",
    "`npm install -g https://github.com/arschmitz/tb-tools`",
    "## Configuration",
    "TB Tools uses a configuration `.tb.json` file in your user's home directory to enable some features.",
    "This file currently contains credentials for phabricator, bugzilla, and optional Notion story lookups, plus optional defaults for Lando. The Lando CLI itself reads credentials from `~/.mozbuild/lando.toml` or its documented environment variables.",
    "### Sample Configuration",
    `\`\`\`json
{
  "phabricator": {
    "user": "arschmitz",
    "token": "cli-uxdexxxkzvy5m5j7xxgajqunxjhe"
  },
  "bugzilla": {
    "user": "arschmitz",
    "apiKey": "36IrYQ06NddTOnnp4IBwpZjROxxxmvvuqUcv1M2v"
  },
  "lando": {
    "repo": "thunderbird-desktop-main"
  },
  "notion": {
    "token": "secret_xxx",
    "dataSourceId": "2f26ee68-df30-4251-aad4-8ddc420cba3d",
    "bugProperty": "Bug",
    "titleProperty": "Name",
    "statusProperty": "Status"
  },
  "reviewCheckout": {
    "firefoxPath": "/path/to/firefox-review",
    "commPath": "/path/to/firefox-review/comm"
  }
}
\`\`\``,
    "",
    "For the browser-based `tb console`, set `reviewCheckout` to an independent Firefox/comm clone pair to enable the Working/Review switch. The desktop app creates paired Git worktrees automatically and uses those paths instead. Both modes keep the Working checkout in place.",
    "",
    "When all four checkout paths are configured, the console's More actions menu provides **Sync Review from Working**. It requires typing `SYNC REVIEW` and removes Review source changes. With desktop worktrees, it detaches Review at the Working commits and keeps its private object directory and shared Git refs. With older independent clones, it retains the existing full clone-sync behavior, including copied build artifacts. Working source changes are not copied.",
    "",
    "For Notion, share the story data source with your Notion connection. The console looks up stories by the configured bug-id property and shows matching page links on selected patches.",
    "",
    "Meta bug boards read story points from Bugzilla's `cf_fx_points` field by default. Set `bugzilla.storyPointsField` in `.tb.json` when a project uses a different custom field.",
    "",
    "The console's Phabricator Authentication menu item uses a separate private browser profile in `~/.tb-tools/phabricator-browser` for inline code suggestions. It is not stored in `.tb.json` or Git. Use Sign Out in the same dialog to remove that profile. If Chrome or Edge is unavailable, install Playwright Chromium with `npx playwright install chromium`.",
    "",
  ];

  pushConsoleSection(lines);
  pushDesktopSection(lines);

  lines.push("## Command List", "##### <ins>Quick Links</ins>");

  optionList.forEach((option) => {
    lines.push(`- [${option.name}](#${option.name})`);
  });
  lines.push(
    `
## Example Development Workflow

1. Start work on a new bug run \`tb create\` and follow prompt
2. Build and open thunderbird \`tb run\`
3. Make changes until ready to commit
4. run lint \`tb lint\`
5. run tests based on your changes \`tb test\`
6. Commit changes \`tb commit\` and follow prompt to generate commit message. New commits include a \`TB-Tools-Id\` trailer so console metadata such as try runs can survive rebases and amends.
7. Make more changes
8. Add changes to your commit \`tb amend\`, selecting new files to add
9. When ready to submit patches to phabricator lint changes, run tests based on changes, push a try run with \`mach try\`, and submit unsubmitted comments in phabricator \`tb submit\`

## Sheriff Duty

The land command is your all in one tool for handling landings in thunderbird. This command integrates with bugzilla, phabricator, and the Lando CLI to form an all in one solution. Just run the land command and tb-tools will check for rust changes and any accompanying patches. Then pulls all bugs marked for checkin and guide you through the process of landing them 1 at a time including viewing and updating the associated bugs and patches. If run with sanity enabled it will run linting and a build at the end before submitting commits through Lando. For detailed workflow and documentation see the land command below.
`,
  );
  optionList.forEach((option) => {
    lines.push(`### ${option.name}`);
    lines.push("---");
    lines.push(option.description);
    lines.push("```bash");
    lines.push(`tb ${option.name}`);
    lines.push("```");
    if (fs.existsSync(path.join("images", `${option.name}.gif`))) {
      lines.push("<br/><br/>");
      lines.push(
        `![Screen recording of ${option.name}.](/images/${option.name}.gif)`,
      );
    }

    if (subOptions[option.name]) {
      lines.push(`#### Options`);
      lines.push(
        "|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|",
      );
      lines.push("|----|-----------|--|--|---|");
      subOptions[option.name].forEach((subOption) => {
        const defaultValue = formatDefaultValue(subOption.defaultValue);
        const example = formatOptionExample(option.name, subOption);
        lines.push(
          `|--${subOption.name}|${subOption.alias ? "-" + subOption.alias : ""}|${subOption.description.replaceAll("|", "\\|")}|${defaultValue}|\`${example}\``,
        );
      });
    }
    lines.push("");
    lines.push("<br/><br/>");
  });
  lines.push("```");
  lines.push(
    ...banner.split(/\n/).map((line) => `                      ${line}`),
  );
  lines.push("```");

  if (fs.existsSync("./README.md")) {
    await writeFile(
      "./README.md",
      `${lines.map((line) => line.trimEnd()).join("\n")}\n`,
    );
  }
}
