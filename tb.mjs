#!/usr/bin/env node

import args from 'command-line-args';
import _try from './commands/try.mjs';
import banner from './lib/banner.mjs';
import bump from './commands/bump.mjs';
import land from './commands/land.mjs';
import readme from './commands/readme.mjs';
import lint from './commands/lint.mjs';
import patchCommand from './commands/patch.mjs';
import rebase from './commands/rebase.mjs';
import submit from './commands/submit.mjs';
import statusCommand from './commands/status.mjs';
import testChanged from './commands/test.mjs';
import update from './commands/update.mjs';
import usage from 'command-line-usage';
import { comment } from './lib/phab.mjs';
import { DEFAULT_LANDO_REPO } from './lib/lando.mjs';
import cleanupCommand from './commands/cleanup.mjs';
import openCommand from './commands/open.mjs';
import preflightCommand from './commands/preflight.mjs';
import {
  checkDir,
  mapBooleanOptions,
  mach,
  machBuild
} from './lib/utils.mjs';
import { amend, commit, handleConflict } from './lib/git.mjs';
import rustCheck from './commands/rust-check.mjs';
import create from './commands/create.mjs';
import diffCommand from './commands/diff.mjs';
import fs from "fs";
import path from "path";
import graphCommand from './commands/graph.mjs';
import consoleCommand from './commands/console.mjs';


const mainDefinitions = [
  { name: 'command', defaultOption: true }
]
const { command, _unknown } = args(mainDefinitions, { stopAtFirstUnknown: true })
const argv = _unknown || [];

const commands = {
  "version": {
    description: false,
    run: async () => {
      const version = fs.readFileSync(path.join(".", "mail", "config", "version.txt"), { encoding: "utf-8" });
      console.log("version", version)
      const simpleVersion = version.split(".")[0];
      const mileStone = `${simpleVersion} Branch`;
      console.log({mileStone})
    }
  },
  conflict: {
    description: false,
    run: async () => {
      await handleConflict();
    }
  },
  amend: {
    description: "Amends the current commit optionally adding new files",
    run: async () => {
      const options = mapBooleanOptions(args(commands.amend.options, { argv }));
      await amend(options);
    },
    header: "Amend options",
    options: [
      { name: "addRemove", alias: "a", description: "Add or remove files added or deleted", defaultValue: "true" }
    ]
  },
  comment: {
    description: "Post a comment to phabricator for current patch",
    header: "Comment Options",
    run: async () => {
      const options = mapBooleanOptions(args(commands.comment.options, { argv }));
      await comment({ message: options.message, resolve: options.resolve });
    },
    options: [
      { name: "message", alias: "m", description: "Comment text to post to phabricator" },
      { name: 'resolve', alias: 'r', description: 'Submit all inline comments and comments marked done', defaultValue: "true" }
    ]
  },
  commit: {
    description: "Create a new commit with message based on your current branch.",
    run: async () => {
      await commit();
    }
  },
  create: {
    description:
`**Setup to work on a new bug**
1. A new branch is created based on a bugzilla bug number \`Bug-XXXXXXX\`.
2. Optionally update to latest Firefox and Thunderbird main.
3. Mark the bug \`Assigned\` and assignee to yourself.`,
    run: async () => {
      const options = mapBooleanOptions(args(commands.create.options, { argv }));
      await create(options);
    },
    header: "Create Options",
    options: [
      { name: "update", alias: "u", description: "Update code before creating branch", defaultValue: "true" },
    ]
  },
  cleanup: {
    description: "Lists and optionally deletes tb-tools checkpoint refs, merged Bug branches, and tb-tools stashes.",
    header: "Cleanup Options",
    options: [
      { name: "base", description: "Base ref used to find merged Bug branches", defaultValue: "origin/main" },
      { name: "refs", description: "Include refs/tb-tools checkpoint refs", defaultValue: "true" },
      { name: "branches", description: "Include merged Bug-N branches", defaultValue: "true" },
      { name: "stashes", description: "Include stashes created by tb-tools", defaultValue: "true" },
      { name: "dryRun", description: "Only print cleanup candidates", defaultValue: "false" },
      { name: "yes", alias: "y", description: "Delete cleanup candidates without prompting", defaultValue: "false" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.cleanup.options, { argv }));
      await cleanupCommand(options);
    },
  },
  diff: {
    description: "Opens a GitHub-style, syntax-highlighted HTML view of `git diff` output, or publishes it as a gist.",
    header: "Diff Options",
    run: async () => {
      await diffCommand(argv);
    },
    options: [
      { name: "gist", alias: "g", description: "Publish the diff to a GitHub gist instead of opening a local HTML view", defaultValue: "false" },
      { name: "public", description: "Publish a public gist. Implies --gist", defaultValue: "false" },
    ]
  },
  graph: {
    description: "Generates and opens a static tabbed branch graph for comm and the Firefox parent checkout.",
    header: "Graph Options",
    options: [
      { name: "limit", alias: "l", description: "Maximum commits to include per checkout", defaultValue: "80" },
      { name: "output", alias: "o", description: "HTML output path" },
      { name: "open", description: "Open the generated graph in a browser", defaultValue: "true" },
      { name: "comm", description: "Include the comm checkout tab", defaultValue: "true" },
      { name: "firefox", description: "Include the Firefox parent checkout tab", defaultValue: "true" },
      { name: "diffs", description: "Embed per-commit diffs for click-to-view", defaultValue: "true" },
      { name: "maxDiffBytes", description: "Maximum embedded diff bytes per commit", defaultValue: "200000" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.graph.options, { argv }));
      await graphCommand(options);
    },
  },
  console: {
    description: "Starts the interactive Thunderbird Desktop Console with live comm and Firefox checkout graphs, server-loaded diffs, origin/main freshness, Rust dependency remote-build warnings, checkout/rebase/prune/amend/submit actions, Bugzilla/Phabricator status, tracked try runs, update/rebase controls, and build/run output.",
    header: "Console Options",
    options: [
      { name: "open", description: "Open the console in a browser", defaultValue: "true" },
      { name: "comm", description: "Include the comm checkout tab", defaultValue: "true" },
      { name: "firefox", description: "Include the Firefox parent checkout tab", defaultValue: "true" },
      { name: "maxDiffBytes", description: "Maximum server-loaded diff bytes per commit", defaultValue: "200000" },
      { name: "pageSize", description: "Commit page size for infinite loading", defaultValue: "80" },
      { name: "port", description: "Localhost port. Use 0 for a random free port", defaultValue: "0" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.console.options, { argv }));
      await consoleCommand(options);
    },
  },
  "build-rebase": {
    description: 'the same as rebase but builds when completed alias for `tb rebase -b`',
    async run() { await rebase({ build: true }) },
  },
  "build-update": {
    description: 'the same as update but builds when completed alias for `tb update -b`',
    async run () { await update({ build: true }); },
  },
  bump: {
    description:
`**Bump thunderbird build Modifying the dummy file**
1. Checks if rust updates are required and if so if patches are available.
2. Updates Firefox and Thunderbird main
3. Updates the dummy file adding or removing a \`.\`,
4. Commits with the message \`No bug, trigger build.\`,
5. Outputs the staged commits for approval
   * Approve - The stack is submitted with the Lando CLI
   * Cancel - The generated commit is discarded
`,
    async run () {
      const options = mapBooleanOptions(args(commands.bump.options, { argv }));
      await bump(options);
    },
    header: "Bump Options",
    options: [
      { name: "lando-repo", description: "Lando repository to push commits to", defaultValue: DEFAULT_LANDO_REPO },
      { name: "relbranch", description: "Push commits to a named release branch" },
    ],
  },
  help: {
    description: "Show help",
    run () { console.log(usage(sections)); },
  },
  land: {
    description:
`**An interactive cli for sheriffing and landing bugs on Thunderbird main.**
1. Checks if rust updates are required and if so if patches are available.
2. Updates Firefox and Thunderbird main
3. Pulls bugs  marked for checkin and associated patches from bugzilla
   * If no bugs are found prompt to bump dummy file
4. Prompts with a list of patches is displayed
   * Displays a list of actions of the patch upon selection.
     - Open bug in default browser
     - Open Patch in default browser
     - Merge Patch
       + If successful - Commit message is updated with individual reviewers removing groups.
       + If failed  **EXPERIMENTAL** -
         * A comment is left asking for it to be rebased
         * checkin-needed-tb is removed
         * A comment is left on phabricator asking for a rebase
         * The patch is rolled back
         * The patch selection is shown again with patch removed
     - Skip
       + The patch is skipped removed from the list
       + Patch selection is displayed
5. Patch selection continues until the stack is aborted or continue is selected
6. Run optional sanity checks
   * Run lint
   * Run Build
7. The stack is displayed for approval
8. Upon approval the stack is submitted with the Lando CLI
9. The bug is updated **EXPERIMENTAL**
   * The milestone is set
`,
    header: "Land Options",
    options: [
      { name: "lando-repo", description: "Lando repository to push commits to", defaultValue: DEFAULT_LANDO_REPO },
      { name: "relbranch", description: "Push commits to a named release branch" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.land.options, { argv }));
      await land(options);
    },
  },
  lint: {
    description: 'Runs commlint on the current local commit and uncommitted changes by default.',
    header: "Lint Options",
    options: [
      { name: "all", description: "Run commlint on all standard comm directories", defaultValue: "false" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.lint.options, { argv }));
      await lint(options);
    },
  },
  open: {
    description: "Opens detected Bugzilla, Phabricator, and Treeherder links for the current work.",
    header: "Open Options",
    options: [
      { name: "target", description: "Link target to open: bug, phab, try, or all", defaultOption: true, multiple: true },
      { name: "bug", description: "Open the detected Bugzilla bug", defaultValue: "false" },
      { name: "phab", description: "Open the detected Phabricator revision", defaultValue: "false" },
      { name: "try", description: "Open the detected Treeherder try run", defaultValue: "false" },
      { name: "all", alias: "a", description: "Open every detected link", defaultValue: "false" },
      { name: "base", description: "Base ref used while detecting pending commit links", defaultValue: "origin/main" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.open.options, { argv }));
      await openCommand(options);
    },
  },
  patch: {
    description: "Applies a Phabricator revision with moz-phab after creating a rollback checkpoint.",
    header: "Patch Options",
    options: [
      { name: "revision", description: "Phabricator revision to apply, for example D123456", defaultOption: true },
      { name: "bug", alias: "b", description: "Create or switch to Bug-N before applying the patch" },
      { name: "checkpoint", description: "Create a rollback checkpoint before applying the patch", defaultValue: "true" },
      { name: "rollback", description: "Prompt to roll back if patching fails", defaultValue: "true" },
      { name: "applyTo", alias: "a", description: "Pass --apply-to to moz-phab patch: a node, here, or base" },
      { name: "raw", description: "Pass --raw to moz-phab patch", defaultValue: "false" },
      { name: "diffId", description: "Pass --diff-id to moz-phab patch" },
      { name: "name", alias: "n", description: "Pass --name to moz-phab patch" },
      { name: "noCommit", description: "Pass --no-commit to moz-phab patch", defaultValue: "false" },
      { name: "noBookmark", description: "Pass --no-bookmark to moz-phab patch", defaultValue: "false" },
      { name: "noTopic", description: "Pass --no-topic to moz-phab patch", defaultValue: "false" },
      { name: "noBranch", description: "Pass --no-branch to moz-phab patch", defaultValue: "false" },
      { name: "skipDependencies", description: "Pass --skip-dependencies to moz-phab patch", defaultValue: "false" },
      { name: "includeAbandoned", description: "Pass --include-abandoned to moz-phab patch", defaultValue: "false" },
      { name: "yes", alias: "y", description: "Pass --yes to moz-phab patch", defaultValue: "false" },
      { name: "safeMode", description: "Pass --safe-mode to moz-phab patch", defaultValue: "false" },
      { name: "forceVcs", description: "Pass --force-vcs to moz-phab patch", defaultValue: "false" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.patch.options, { argv }));
      await patchCommand(options);
    },
  },
  preflight: {
    description: "Runs a submit-readiness workflow: status, lint, tests, and optional diff or try.",
    header: "Preflight Options",
    options: [
      { name: "base", description: "Base ref used while showing status", defaultValue: "origin/main" },
      { name: "skipLint", description: "Skip lint", defaultValue: "false" },
      { name: "skipTest", description: "Skip tests", defaultValue: "false" },
      { name: "diff", description: "Open a pretty diff after lint and tests", defaultValue: "false" },
      { name: "try", description: "Push a mach try run after lint and tests", defaultValue: "false" },
      { name: 'flavor', alias: 'f', description: 'Flavor of tests to run `browser|unit|all`', defaultValue: 'all' },
      { name: 'pattern', alias: 'p', description: 'Test path or glob pattern to pass to `mach test`', defaultOption: true, multiple: true },
      { name: 'selector', alias: 's', description: 'mach try selector `auto|fuzzy|empty|chooser`', defaultValue: "auto" },
      { name: 'query', alias: 'q', description: 'fuzzy selector query' },
      { name: 'tasks-regex', alias: 't', description: 'auto selector task regex' },
      { name: 'preset', description: 'mach try preset to load' },
      { name: 'artifact', description: 'force artifact builds where possible', defaultValue: 'true' },
      { name: 'comment', alias: 'c', description: 'Post try link as comment to phab revision', defaultValue: "false" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.preflight.options, { argv }));
      await preflightCommand(options);
    },
  },
  readme: {
    description: false,
    run: () => readme(optionList, subOptions),
  },
  rebase: {
    description:
`**Rebase your current state**
1. Stashes any uncommitted change
2. Checks for rust updates with option to abort
3. Updates Firefox and Thunderbird main
4. Rebases your current branch onto Thunderbird main
5. Unstashes any uncommitted changes`,
    async run () {
      const options = mapBooleanOptions(args(commands.rebase.options, { argv }));
      await rebase(options);
    },
  },
  run: {
    description: "builds and launches thunderbird",
    async run () {
      await machBuild();
      await mach("run");
    }
  },
  "rust-check": {
    description: `
**Check for rust updates**
1. Creates a checkpoint for Firefox main
2. Pulls changes from Firefox main
3. Check for required rust updates
   * If updates are required
     1. Pull Thunderbird main and see if required changes have already been merged
     2. Check if rust updates are required
     3. If updates are still required check phabricator for patches.
     4. If no patches are found abort
`,
    run: async () => {
      await rustCheck();
    }
  },
  "run-rebase": {
    description: 'The same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`' ,
    async run() { await rebase({ run: true }) },
  },
  "run-update": {
    description: 'The same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`' ,
    async run () { await update({ run: true }); },
  },
  submit: {
    description: `Submits to phabricator.
Optionally:
* Check for changes
  * Prompt to amend current commit
* Prompt to run lint
* Prompt to run tests
* Prompt to submit a try run and post as a comment on phabricator
* Prompt to Submit pending inline comments and comments marked as done,
`,
    header: 'Submit Options',
    options: [],
    async run () {
      const options = mapBooleanOptions(args(commands.submit.options, { argv }));
      await submit(options, commands.try.options);
    },
  },
  status: {
    description: "Shows current branch, pending commits, changed files, and detected Bugzilla/Phabricator/Try links.",
    header: "Status Options",
    options: [
      { name: "base", description: "Base ref used to count and list pending commits", defaultValue: "origin/main" },
    ],
    async run () {
      const options = mapBooleanOptions(args(commands.status.options, { argv }));
      await statusCommand(options);
    },
  },
  test: {
    description: "Runs matching test patterns, or checks files changed or added and runs tests for any components modified.",
    header: 'Test Options',
    async run () {
      const options = mapBooleanOptions(args(commands.test.options, { argv }));
      await testChanged(options);
    },
    options: [
      { name: 'flavor', alias: 'f', description: 'Flavor of tests to run `browser|unit|all`', defaultValue: 'all' },
      { name: 'pattern', alias: 'p', description: 'Test path or glob pattern to pass to `mach test`', defaultOption: true, multiple: true },
    ]
  },
  try: {
    description: "pushes a try run through mach try with option to comment on phabricator with link",
    header: 'Try Options',
    options: [
      { name: 'selector', alias: 's', description: 'mach try selector `auto|fuzzy|empty|chooser`', defaultValue: "auto" },
      { name: 'query', alias: 'q', description: 'fuzzy selector query' },
      { name: 'tasks-regex', alias: 't', description: 'auto selector task regex' },
      { name: 'preset', description: 'mach try preset to load' },
      { name: 'artifact', description: 'force artifact builds where possible', defaultValue: 'true' },
      { name: 'comment', alias: 'c', description: 'Post try link as comment to phab revision', defaultValue: "false" },
    ],
    async run () {
      const tryArgOptions = mapBooleanOptions(args(commands.try.options, { argv }));
      await _try(tryArgOptions);
    }
  },
  update: {
    description: 'pulls Firefox and Thunderbird main updates and checks for rust changes',
    header: 'Update/Rebase Options',
    async run () {
      const options = mapBooleanOptions(args(commands.update.options, { argv }));
      await update(options);
    },
    options: [
      { name: 'run', alias: 'r', description: 'build run thunderbird when the update complete', defaultValue: false },
      { name: 'build', alias: 'b', description: 'build thunderbird when the update is complete', defaultValue: false },
      { name: 'force', alias: 'f', description: 'Continue update despite out of sync rust dependencies', defaultValue: false },
    ]
  },
};

commands.rebase.options = commands.update.options;
commands.submit.options = [...commands.submit.options, ...commands.test.options, ...commands.try.options];

const optionList = [];
const subOptions = {};

const sections = [
  { content: banner, raw: true },
  {
      header: 'TB Tools',
      content: 'Simplify tasks related to developing thunderbird'
  },
  {
      header: 'Synopsis',
      content: [ '$ tb update', '$ tb bump' ]
  },
  {  header: 'Commands', content: optionList },
];

function getUsageOptions(options) {
  return options.map((option) => {
    const usageOption = { ...option };
    delete usageOption.defaultOption;
    delete usageOption.multiple;
    return usageOption;
  });
}

Object.entries(commands).forEach(([name, { description, header, options }]) => {
  if (!description) {
    return;
  }

  optionList.push({ name, description });

  if (options) {
    subOptions[name] = options;
  }

  if (!header) {
    return;
  }

  sections.push({ header, content: getUsageOptions(options) });
});

if (command && !["help", "readme"].includes(command)) {
  checkDir();
}

async function capture() {
  try {
    await commands[command].run();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

if (commands[command]) {
  capture();
} else {
  commands["help"].run();
}
