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
  mach
} from './lib/utils.mjs';
import { amend, commit } from './lib/hg.mjs';
import rustCheck from './commands/rust-check.mjs';
import create from './commands/create.mjs';

const mainDefinitions = [
  { name: 'command', defaultOption: true }
]
const { command, _unknown } = args(mainDefinitions, { stopAtFirstUnknown: true })
const argv = _unknown || [];

const commands = {
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
    description: "Setup a new bookmark based on a bugzilla bug. Optionally updates to latest prior. Marks the bug assigned and assignee to yourself.",
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
    description: "Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.",
    run: bump
  },
  help: {
    description: "Show help",
    run () { console.log(usage(sections)); },
  },
  land: {
    description: "checks for rust updates, updates to the latest C-C and M-C, pulls bugs from bugzilla with keyword `checkin-needed-tb` and Interactivly land patches, allowing to view the bug or patch, then updates the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.",
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
    description: 'Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes',
    async run () {
      const options = mapBooleanOptions(args(commands.rebase.options, { argv }));
      await rebase(options);
    },
  },
  run: {
    description: "builds and launches thunderbird",
    async run () {
      await mach("build");
      await mach("run");
    }
  },
  "rust-check": {
    description: "Check for upstream rust changes without updating locally",
    run: async () => {
      await rustCheck();
    }
  },
  "run-rebase": {
    description: 'the same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`' ,
    async run() { await rebase({ run: true }) },
  },
  "run-update": {
    description: 'the same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`' ,
    async run () { await update({ run: true }); },
  },
  submit: {
    description: "Submits to phabricator, optionally running lint and related tests first and posting a try run and submitting pending comments after.",
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
      { name: 'update', alias: 'u', description: 'Check for update and rebase before submitting' },
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
    description: "pushes a try run",
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