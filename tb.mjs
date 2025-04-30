#!/usr/bin/env node

import args from 'command-line-args';
import _try from './commands/try.mjs';
import banner from './lib/banner.mjs';
import bump from './commands/bump.mjs';
import land from './commands/land.mjs';
import readme from './commands/readme.mjs';
import lint from './commands/lint.mjs';
import rebase from './commands/rebase.mjs';
import submit from './commands/submit.mjs';
import testChanged from './commands/test.mjs';
import update from './commands/update.mjs';
import usage from 'command-line-usage';
import { comment } from './lib/phab.mjs';
import {
  checkDir,
  mapBooleanOptions,
  mach,
  machBuild
} from './lib/utils.mjs';
import { amend, commit, handleConflict } from './lib/hg.mjs';
import rustCheck from './commands/rust-check.mjs';
import create from './commands/create.mjs';
import { getBug } from './lib/bugzilla.mjs';

const mainDefinitions = [
  { name: 'command', defaultOption: true }
]
const { command, _unknown } = args(mainDefinitions, { stopAtFirstUnknown: true })
const argv = _unknown || [];

const commands = {
  "get-bug": {
    description: false,
    run: async () => {
      console.log((await getBug(1878375)).bugs[0].keywords)
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
      await amend();
    },
    header: "Amend options",
    options: [
      { name: "addRemove", alias: "a", description: "Add or remove files added or deleted" }
    ]
  },
  comment: {
    description: "Post a comment to phabricator for current patch",
    header: "Comment Options",
    run: async () => {
      const options = mapBooleanOptions(args(commands.comment.options, { argv }));
      await comment(options.message, options.resolve);
    },
    options: [
      { name: "message", alias: "m", description: "Comment text to post to phabricator" },
      { name: 'resolve', alias: 'r', description: 'Submit all inline comments and comments marked done', defaultValue: "true" }
    ]
  },
  commit: {
    description: "Create a new commit with message based on your current bookmark.",
    run: async () => {
      await commit();
    }
  },
  create: {
    description:
`**Setup to work on a new bug**
1. A new bookmark is created based on a bugzilla bug number \`Bug-XXXXXXX\`.
2. Optionally update to latest M-C and C-C.
3. Mark the bug \`Assigned\` and assignee to yourself.`,
    run: async () => {
      const options = mapBooleanOptions(args(commands.create.options, { argv }));
      await create(options);
    },
    header: "Create Options",
    options: [
      { name: "update", alias: "u", description: "Update code before creating bookmark", defaultValue: "true" },
    ]
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
2. Updates Mozilla-central and comm-central
3. Updates the dummy file adding or removing a \`.\`,
4. Commits with the message \`No bug, trigger build.\`,
5. Outputs the staged commits for approval",
   * Approve - The stack is pushed to comm-central
   * Cancel - The current state is pruned
`,
    run: bump
  },
  help: {
    description: "Show help",
    run () { console.log(usage(sections)); },
  },
  land: {
    description:
`**An interactive cli for sherifing and landing bugs on comm central.**
1. Checks if rust updates are required and if so if patches are available.
2. Updates mozilla-central and comm-central
3. Pulls bugs  marked for checkin and associated patches from bugzilla
   * If no bugs are found prompt to bump dummy file
4. Prompts with a list of patches is displayed
   * Displays a list of actions of the patch upon selection.
     - Open bug in default browser
     - Open Patch in default browser
     - Merge Patch
       + If successful - Commit message is updated with individual reviewers removing groups.
       + If failed  **EXPIRAMENTAL** -
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
8. Upon approved the stack is pushed to comm-central
9. The bug is updated **EXPIRAMENTAL**
   * The milestone is set
`,
    run: land
  },
  lint: {
    description: 'run commlint on all files',
    async run () {
      await lint();
    },
  },
  readme: {
    description: false,
    run: () => readme(optionList, subOptions),
  },
  rebase: {
    description:
`**Rebase your current state**
1. Stashes any uncommited change
2. Checks for rust updates with option to abort
3. Updates M-C and C-C
4. Rebase your current stack
4. Uunstashes any uncommited changes`,
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
1. Creates a checkpoint for M-C
2. Pull changes from M-C
3. Check for required rust updates
   * If updates are required
     1. Pull C-C and see if required changes have already been merged
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
* Run lint
* Run tests
* Submit a try run and post as a comment on phabricator
* Submit pending inline comments and comments marked as done,
`,
    header: 'Submit Options',
    async run () {
      const options = mapBooleanOptions(args(commands.submit.options, { argv }));
      await submit(options, commands.try.options);
    },
    options: [
      { name: 'lint', alias: 'l', description: 'lint before submitting patch', defaultValue: "true" },
      { name: 'test', alias: 't', description: 'run all tests for any components or files modified before submitting patch', defaultValue: "true" },
      { name: 'try', description: 'Submit a try run and comment with the link', defaultValue: "true" },
      { name: 'resolve', alias: 'r', description: 'Submit all inline comments and comments marked done', defaultValue: "true" },
      { name: 'update', description: 'Check for update and rebase before submitting' },
    ]
  },
  test: {
    description: "Checks files changed or added and runs all tests for any components modified, and test files changed.",
    header: 'Test Options',
    async run () {
      const options = mapBooleanOptions(args(commands.test.options, { argv }));
      await testChanged(options);
    },
    options: [
      { name: 'flavor', alias: 'f', description: 'Flavor of tests to run `browser|unit|all`', defaultValue: 'all' },
    ]
  },
  try: {
    description: "pushes a try run with option to comment on phabricator with link",
    header: 'Try Options',
    options: [
      { name: 'unit-tests', alias: 'u', description: 'type of tests to run `mochitest|xpcshell|all`', defaultValue: "all" },
      { name: 'build-types', alias: 'b', description: 'build types to run', defaultValue: "o" },
      { name: 'artifact', description: 'do an artifact build', defaultValue: 'true' },
      { name: 'platform', alias: 'p', description: 'platforms to run tests on', defaultValue: "all" },
      { name: 'comment', alias: 'c', description: 'Post try link as comment to phab revision', defaultValue: "false" }
    ],
    async run () {
      const tryArgOptions = args(commands.try.options, { argv })
      await _try(tryArgOptions, commands.try.options);
    }
  },
  update: {
    description: 'pulls m-c & c-c updates to tip and checks for rust changes',
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

  sections.push({ header, content: options });
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