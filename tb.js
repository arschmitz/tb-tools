#!/usr/bin/env node

const args = require('command-line-args');
const usage = require('command-line-usage');
const util = require('util');
const execOriginal = require('child_process').exec
const exec = util.promisify(execOriginal);
const spawn = require('child_process').spawn;
const { readFile, writeFile } = require('node:fs/promises');
const readlineSync = require("readline-sync");
const fs = require('fs');
const path = require('path');
const ospath = require('ospath');

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

async function executeCommand(_command, log) {
  const { stdout, stderr } = await exec(_command);
  if (stderr) {
    throw new Error(stderr);
  }
  if(log) {
    console.log(stdout);
  }
  return stdout;
}

async function spawnCommand(_command, options) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const cmd = typeof _command === "string" ? _command : _command.cmd;
  const args = typeof _command === "string" ? [] : _command.args;
  const parts = cmd.split(' ');
  const io = spawn(parts.shift(), [...parts, ...args], { stdio: 'inherit', ...options });

  io.on('exit', function (code) {
    if (code > 0) {
      reject(code);
    } else {
      resolve(code);
    }
  });

  await promise;
}

async function chainCommands(commands, options) {
  let promise = decideCommand(commands[0]);

  commands.shift();

  for (let _command of commands) {
    promise = promise.then(() => decideCommand(_command));
  }

  return promise;
}

async function decideCommand(command, options) {
  if (typeof command === "object" && command.execute) {
    return executeCommand(command.cmd);
  }

  return spawnCommand(command, options);
}

const banner =
`                                        .....
                                ..::-------====---:..
                             .:---====================:.    
            ..             ::-====================-:
            ===:          :-=-   -===================-:
           :====-       .::--=--=====================-::
          :======-    :::--===========================.
         -========.  :--===============================.
       .==========:  -=:..        ..:-==================.
   :.  ===++++++++-                    :================-
  .== -+++++++++++.                      :===============.
  :++-+++++=-++++.                        .===============
  -+++++++---+++-  ..                  ..  :============++
  -++++++--===++.   ...             ....   .============++
  -=++++=-====++:    ...:.        .:..     :===========+++
  :=++++--=====+=      ..::.    ::...     .============++-
  .==+++=-======*-      ....::::...      :============+++.
   -==+*=--======+-....................:-===========++++=
    ===++--=======++:..............::-=============+++++
     ===++==========+=:......----------==========++++++.
      =================+=-:...:================+++++++.     
       -++++=================--::--=========++++++++=
        .=++++++=========================++++++++++:        
          :=+++++++++===============+++++++++++++:
            .-++++++++++++++++++++++++++++++++=.
               .-++++++++++++++++++++++++++-:
                   :-=++++++++++++++++=-:.
                         ..::::::..
`;

const optionList = [
  { name: 'bump', description: 'Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.' },
  { name: 'lint', description: 'run commlint on all files' },
  { name: 'rebase', description: 'Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes' },
  { name: 'build-rebase', description: 'the same as rebase but builds when completed alias for `tb rebase -b`' },
  { name: 'run-rebase', description: 'the same as rebase but builds and runs when completed. Alias for `tb rebase -r` or `tb rebase && tb run`' },
  { name: 'update', description: 'pulls m-c & c-c updates to tip and checks for rust changes' },
  { name: 'build-update', description: 'the same as update but builds when completed alias for `tb update -b`' },
  { name: 'run-update', description: 'the same as update but builds and runs when completed. Alias for `tb update -r` or `tb update && tb run`' },
  { name: 'test', description: 'Checks files changed or added and runs all tests for any components modified, and test files changed.' },
  { name: 'submit', description: 'lints all files and submits to phabricator' },
  { name: 'try', description: 'pushes a try run' },
  { name: 'run', description: 'builds and launches thunderbird' },
  { name: 'land', description: 'updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.' },
  { name: 'help', description: 'Show help' },
];

const subOptions = {
  submit: [
    { name: 'lint', alias: 'l', description: 'lint before submitting patch', defaultValue: "true" },
    { name: 'test', alias: 't', description: 'run all tests for any components or files modified before submitting patch', defaultValue: "true" }
  ],
  test: [
    { name: 'flavor', alias: 'f', description: 'Flavor of tests to run `browser|unit|all`', defaultValue: 'all' },
  ],
  try: [
    { name: 'unit-tests', alias: 'u', description: 'type of tests to run `mochitest|xpcshell|all`', defaultValue: "all" },
    { name: 'build-types', alias: 'b', description: 'build types to run', defaultValue: "o" },
    { name: 'artifact', description: 'do an artifact build', defaultValue: 'true' },
    { name: 'platform', alias: 'p', description: 'platforms to run tests on', defaultValue: "all" },
  ],
  update: [
    { name: 'run', alias: 'r', description: 'build run thunderbird when the update complete', defaultValue: false },
    { name: 'build', alias: 'b', description: 'build thunderbird when the update is complete', defaultValue: false }
  ]
}

subOptions.submit = [...subOptions.submit, ...subOptions.test];

const sections = [
  {
      content: banner,
      raw: true
  },
  {
      header: 'TB Tools',
      content: 'Simplify tasks related to developing thunderbird'
  },
  {
      header: 'Synopsis',
      content: [
        '$ tb update',
        '$ tb bump'
      ]
  },
  {
      header: 'Commands',
      content: optionList
  },
  {
    header: 'Try Options',
    content: subOptions.try
  },
  {
    header: 'Update/Rebase Options',
    content: subOptions.update
  },
  {
    header: 'Submit Options',
    content: subOptions.submit
  },
  {
    header: 'Test Options',
    content: subOptions.test
  }
];

const mainDefinitions = [
  { name: 'command', defaultOption: true }
]
const { command, _unknown } = args(mainDefinitions, { stopAtFirstUnknown: true })
const argv = _unknown || [];
const lintDirs = ["build", "calendar", "chat", "docs", "mail", "tools"];

runCommand(command);

async function runCommand() {
  switch (command) {
    case "lint":
      try {
        checkDir();
        await Promise.all(lintDirs.map((dir) => spawnCommand(`../mach commlint ${dir} --fix`)));
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "rebase": {
      const options = mapBooleanOptions(args(updateOptionList, { argv }));
      await rebase(options);
      break;
    }
    case "build-rebase":
      await rebase({ build: true });
      break;
    case "run-rebase":
      await rebase({ run: true });
      break;
    case "update": {
      const options = mapBooleanOptions(args(updateOptionList, { argv }));
      await update(options);
      break;
    }
    case "build-update":
      await update({ build: true });
      break;
    case "run-update":
      await update({ run: true });
      break;
    case "bump":
      try {
        checkDir();
        await update();
        await chainCommands([
          "../mach tb-rust check-upstream",
        ]);
        await update_dummy();

        await chainCommands([
          {
            cmd: "hg",
            args: ["commit", "-m", `"No bug, trigger build."`]
          },
          "hg out -r .",
        ]);

        const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

        if (correct) {
          await chainCommands([{
            cmd: "hg",
            args: ["push", "-r", ".", "ssh://hg.mozilla.org/comm-central"],
          }]);
        } else if (correct === false) {
          process.exit(1);
        } else {
          console.info("Rolling back changes");
          await chainCommands([
            {
              cmd: "hg",
              args: ["prune", "."],
            }
          ]);
          process.exit(1);
        }

      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "submit":
      try {
        checkDir();
        const options = mapBooleanOptions(args(submitOptionList, { argv }));
        await checkForChanges("Changes found please ammend, commit or shelve your changes.");

        if (options.lint) {
          await Promise.all(lintDirs.map((dir) => spawnCommand(`../mach commlint ${dir} --fix`)));
          await checkForChanges("Files updated by lint.");
        }

        if (options.test) {
          await testChanged();
        }

        await chainCommands(['moz-phab submit']);

      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "try":
      try {
        checkDir();
        const tryArgOptions = args(tryOptionList, { argv })
        const tryOptions = Object.keys(tryArgOptions).map((option) => {
          const name = tryOptionList.find((_option) => _option.name === option).alias;

          if (!name && tryArgOptions[option] !== "false") {
            return `--${option}`;
          } else if (!name) {
            return;
          }

          return [`-${name}`, tryArgOptions[option]].join(" ");
        }).join(" ");

        await chainCommands([
          {
            cmd: "hg",
            args: [
              "push-to-try",
              "-s",
              "ssh://hg.mozilla.org/try-comm-central",
              "-m",
              `try: ${tryOptions}`
            ]
          }
        ]);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "run":
      checkDir();
      try {
        await chainCommands(["../mach build", "../mach run"]);
      } catch (error) {
      }
      break;
    case "check-dir":
      try {
        checkDir();
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "test":
      const options = mapBooleanOptions(args(testOptionList, { argv }));
      await testChanged(options);
      break;
    case "land":
      await landPatch();
      await chainCommands([
        "hg out -r .",
      ]);

      const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

      if (correct) {
        await chainCommands([{
          cmd: "hg",
          args: ["push", "-r", ".", "ssh://hg.mozilla.org/comm-central"],
        }]);
      } else if (correct === false) {
        process.exit(1);
      } else {
        console.info("Rolling back changes");
        await chainCommands([
          {
            cmd: "hg",
            args: ["prune", "."],
          }
        ]);
        process.exit(1);
      }
      break;
    case "readme":
      const lines = [
        "# TB Tools - Thunderbird CLI Tools",
        "Simplify tasks related to developing thunderbird.",
        "",
        "Right now these are only things that i have personally used and found useful but happy to add more.",
        "## Instalation",
        "`npm install -g https://github.com/arschmitz/tb-tools`",
        "## Command List",
        "##### <ins>Quick Links</ins>"
      ];

      optionList.forEach((option) => {
        lines.push(`- [${option.name}](#${option.name})`)
      });
      optionList.forEach((option) => {
        lines.push(`### ${option.name}`);
        lines.push("---");
        lines.push(option.description);
        lines.push("```bash");
        lines.push(`tb ${option.name}`);
        lines.push("```");

        if (subOptions[option.name]) {
          lines.push(`#### Options`);
          lines.push("|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|");
          lines.push("|----|-----------|--|--|");
          subOptions[option.name].forEach((subOption) => {
            lines.push(`|${subOption.name}|${subOption.alias || ""}|${subOption.description.replaceAll("|", "\\|")}|${subOption.defaultValue}|`);
          });
        }
      });
      lines.push("```");
      lines.push(...banner.split(/\n/).map((line) => `                      ${line}`));
      lines.push("```");

      if (fs.existsSync("./README.md")) {
        await writeFile("./README.md", lines.join("\n"));
      }
      break;
    default:
      console.log(usage(sections));
  }
}

async function rebase({ build, run }) {
  try {
    checkDir();
    const startCommit = await chainCommands([{ cmd: 'hg id -i', execute: true }]);
    let shelved;
    try {
      await chainCommands(["hg shelve"]);
      shelved = true;
    } catch {
      // no changes to shelve
    }
    await update();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const tip = await chainCommands([{ cmd: 'hg id -i', execute: true }]);
    await chainCommands([`hg up ${startCommit}`]);
    let stackParent;
    try {
      stackParent = await chainCommands([{
        cmd: "hg log -r 'first(stack())' --template '{node}'",
        execute: true
      }]);
    } catch {
      // no stack
    }
    if (stackParent) {
      try {
        await chainCommands([
          `hg rebase -b ${stackParent} -d ${tip}`
        ]);
      } catch {
        // nothing to rebase
      }
    }
    if (shelved) {
      await chainCommands(["hg unshelve"]);
    }

    if (build || run) {
      await chainCommands(["../mach build"]);
    }

    if (run) {
      await chainCommands(["../mach run"])
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function testChanged({ type = "all" } = {}) {
  const files = (await executeCommand("hg status --change .", false)).split(/\n/);
  const dirtyFiles = (await executeCommand("hg status -mard", false)).split(/\n/);

  const tests = [...files, ...dirtyFiles].reduce((collection, item) => {
    item = item.slice(2);
    if (!item) {
      return collection;
    }

    if (!/components/.test(item)) {
      collection.add(item);
      return collection;
    }

    const componentPath = item.split("components")[1];
    const name = componentPath.split(path.sep)[1];

    if (name === "storybook") {
      return collection;
    }

    let _path = `${path.join("mail", "components", name)}`
    if (type !== "all") {
      _path = path.join(_path, "test", type)
    }

    collection.add(_path);

    return collection;
  }, new Set());

  await chainCommands([{
    cmd: "../mach",
    args: ["test", ...Array.from(tests)]
  }], { cwd: ".." });
}

async function landPatch() {
  const patchNumber = readlineSync.question("Enter DXXXX number of patch:");

  console.info(`Landing ${patchNumber}… Please update the patch comment with the actual approver and remove any review groups`);

  await chainCommands([
    `moz-phab patch ${patchNumber} --no-bookmark --skip-dependencies --apply-to .`,
  ]);

  const message = await chainCommands([{ cmd: "hg log -v --limit 1", execute: true }]);
  const lines = message.split(/\n/)
  const messageParts = lines[0].split(".");
  const reviewers = messageParts.findLast().split(",").filter((item) => !/^#/.test(item)).join(",");
  messageParts.pop();
  messageParts.push(reviewers);

  lines.shift();
  lines.unshift(messageParts.join("."));

  await chainCommands([
    `moz-phab patch ${patchNumber} --no-bookmark --skip-dependencies --apply-to .`,
    { cmd: "hg", args: [ "commit", "--ammend", "--date", "now", "-m", lines.join("\n") ] },
  ]);

  const correct = readlineSync.keyInYN("Would you like to add another patch? [y/n]:", { guide: false });

  if (correct) {
    await landPatch();
  }
}

function mapBooleanOptions(options) {
  Object.keys(options).map((option) => {
    options[option] = options[option] === null ? true : options[option];
  });

  return options;
}

async function checkForChanges(message) {
  try {
    await executeCommand("hg id --template {dirty} | (grep \+  && exit 1 || exit 0)");;
  } catch {
    console.warn(message);
    const amend = readlineSync.keyInYN("Amend commit? [y/n]:", { guide: false });

    if (!amend) {
      process.exit(1);
    }

    try {
      const message = await executeCommand("hg log --template {desc} -l 1");
      await chainCommands([{ cmd: "hg", args: ["commit", "--amend", "--message" , message] }]);
    } catch {
      console.error("Commit failed aborting!");
      process.exit(1);
    }
  }
}

async function update({ build = false, run = false } = {}) {
  try {
    await chainCommands([
      { cmd: "cd .. && hg pull central", execute: true },
      { cmd: "cd .. && hg up central", execute: true },
      "hg pull comm",
      "hg up comm",
      "../mach tb-rust check-upstream"
    ]);

    if (build || run) {
      await chainCommands(["../mach build"]);
    }

    if (run) {
      await chainCommands(["../mach run"])
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function update_dummy() {
  const contents = await readFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', { encoding: 'utf8' });
  const lines = contents.split(/\n/);
  let dotLine = lines[lines.length - 2];
  const dots = dotLine.match(/\./g)

  if (dots.length === 1) {
    dotLine = '..'
  } else {
    dots.pop()
    dotLine = dots.join('');
  }

  lines[lines.length - 2] = dotLine;

  newContent = lines.join('\n');

  await writeFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', newContent);

  console.log('Updated Dummy File');
}

function checkDir() {
  const parts = process.cwd().split("/");
  const dirName = parts[parts.length - 1];
  const inDir = dirName === "comm";

  console[inDir ? 'log' : 'error'](`comm${inDir ? "" : " not"} directory found`);
  if (!inDir) {
    throw new Error("comm directory not found");
  }
}