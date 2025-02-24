#!/usr/bin/env node

const args = require('command-line-args');
const usage = require('command-line-usage');
const util = require('util');
const execOriginal = require('child_process').exec
const exec = util.promisify(execOriginal);
const spawn = require('child_process').spawn;
const { readFile, writeFile } = require('node:fs/promises');
const readlineSync = require("readline-sync");

async function executeCommand(_command) {
  const { stdout, stderr } = await exec(_command);
  if (stderr) {
    throw new Error(stderr);
  }
  console.log(stdout);
  return stdout;
}

async function spawnCommand(_command) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const cmd = typeof _command === "string" ? _command : _command.cmd;
  const args = typeof _command === "string" ? [] : _command.args;
  const parts = cmd.split(' ');
  const io = spawn(parts.shift(), [...parts, ...args], { stdio: 'inherit' });

  io.on('exit', function (code) {
    if (code > 0) {
      reject(code);
    } else {
      resolve(code);
    }
  });

  await promise;
}

async function chainCommands(commands) {
  let promise = decideCommand(commands[0]);

  commands.shift();

  for (let _command of commands) {
    promise = promise.then(() => decideCommand(_command));
  }

  return promise;
}

async function decideCommand(command) {
  if (typeof command === "object" && command.execute) {
    return executeCommand(command.cmd);
  }

  return spawnCommand(command);
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
  { name: 'help', description: 'Show help' },
  { name: 'bump', description: 'Bump thunderbird build by modifying the dummy file. This command updates to the current state using `update`, checks for rust changes, updates the dummy file adding or removing a `.`, commits with the message `No bug, trigger build.`, outputs the staged commits to ensure it is just the build trigger, asks you to verify changes, and either pushes or cleans up the changes based on input.' },
  { name: 'lint', description: 'run commlint on all files' },
  { name: 'rebase', description: 'Stashes any uncommited change, pulls m-c & c-c rebases your current stack and unstashes any uncommited changes' },
  { name: 'update', description: 'pulls m-c & c-c updates to tip and checks for rust changes' },
  { name: 'build-update', description: 'the same as update but builds when completed' },
  { name: 'go', description: 'goes to the comm folder if location is configured in settings' },
  { name: 'submit', description: 'lints all files and submits to phabricator' },
  { name: 'try', description: 'pushes a try run' },
  { name: 'run', description: 'builds and launches thunderbird' },
  { name: 'land', description: 'updates to the latest C-C and M-C then Interactivly land patches, updating the commit messages to remove group reviewers. Finally confirms the stack and pushes or reverts and cleans up.' }
];
const tryOptionList = [
  { name: 'unit-tests', alias: 'u', description: 'run unit tests', defaultValue: "mochitest" },
  { name: 'build-types', alias: 'b', description: 'build types to run', defaultValue: "o" },
  { name: 'artifact', description: 'do an artifact build', defaultValue: 'true' },
  { name: 'platform', alias: 'p', description: 'platforms to run tests on', defaultValue: "all" },
];

const sections = [
  {
      content: banner,
      raw: true
  },
  {
      header: 'TB_CLI',
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
    content: tryOptionList
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
    case "rebase":
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
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
      break;
    case "update":
      await update();
      break;
    case "build-update":
      try {
        await update();
        await chainCommands([
          {
            cmd: "../mach",
            args: ["build"],
          }
        ]);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
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
    case "go":
      break;
    case "update-patch":
      break;
    case "submit":
      try {
        checkDir();
        const cmds = lintDirs.map((dir) => `../mach commlint ${dir} --fix`);
        cmds.push('moz-phab submit');
        await chainCommands(cmds);
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
        console.log(tryOptions)
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
    case "land":
      await landPatch();
      await chainCommands([
        "hg out -r .",
      ]);

      const correct = readlineSync.keyInYN("Does the output look correct? [y/n/c]:", { guide: false });

      if (correct) {
        // await chainCommands([{
        //   cmd: "hg",
        //   args: ["push", "-r", ".", "ssh://hg.mozilla.org/comm-central"],
        // }]);
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
    default:
      console.log(usage(sections));
  }
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

async function update() {
  try {
    await chainCommands([
      { cmd: "cd .. && hg pull central", execute: true },
      { cmd: "cd .. && hg up central", execute: true },
      "hg pull comm",
      "hg up comm",
      "../mach tb-rust check-upstream"
    ]);
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