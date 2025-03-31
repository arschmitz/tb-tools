#!/usr/bin/env node

import _try from './commands/try.mjs';
import args from 'command-line-args';
import banner from './lib/banner.mjs';
import bump from './commands/bump.mjs';
import fs from 'fs';
import land from './commands/land.mjs';
import ospath from 'ospath';
import path from 'path';
import readme from './commands/readme.mjs';
import rebase from './commands/rebase.mjs';
import submit from './commands/submit.mjs';
import testChanged from './commands/test.mjs';
import update from './commands/update.mjs';
import usage from 'command-line-usage';

import {
  executeCommand,
  spawnCommand,
  chainCommands,
  checkDir,
  mapBooleanOptions,
  checkForChanges
} from './lib/utils.mjs';

const filePath = path.join(ospath.home(), '.tb');
let settings = {};

try {
  const data = fs.readFileSync(filePath, 'utf-8');
  settings = JSON.parse(data);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.info('Settings file not found using default settings.');
  } else if (error instanceof SyntaxError) {
    console.error('Error parsing settings file JSON:', error.message);
  } else {
    console.error('An unexpected error occurred loading settings:', error);
  }
}

const mainDefinitions = [
  { name: 'command', defaultOption: true }
]
const { command, _unknown } = args(mainDefinitions, { stopAtFirstUnknown: true })
const argv = _unknown || [];
const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];

const commands = {
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
    description: "updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.",
    run: land
  },
  lint: {
    description: 'run commlint on all files',
    async run () {
      try {
        checkDir();
        await Promise.all(lintDirs.map((dir) => spawnCommand(`../mach commlint ${dir} --fix`)));
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    },
  },
  readme: {
    description: false,
    run: readme,
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
      checkDir();
      try {
        await chainCommands(["../mach build", "../mach run"]);
      } catch (error) {
      }
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
    description: "Submits to phabricator, optionally running lint and related tests first",
    header: 'Submit Options',async run () {
      const options = mapBooleanOptions(args(commands.submit.options, { argv }));
      await submit(options);
    },
    options: [
      { name: 'lint', alias: 'l', description: 'lint before submitting patch', defaultValue: "true" },
      { name: 'test', alias: 't', description: 'run all tests for any components or files modified before submitting patch', defaultValue: "true" }
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
      { name: 'build', alias: 'b', description: 'build thunderbird when the update is complete', defaultValue: false }
    ]
  },
};

commands.rebase.options = commands.update.options;
commands.submit.options = [...commands.submit.options, ...commands.test.options];

const optionList = [];

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

  if (!header) {
    return;
  }

  sections.push({ header, content: options });
});

if (commands[command]) {
  commands[command].run();
} else {
  commands["help"].run();
}