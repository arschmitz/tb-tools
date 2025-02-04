#!/usr/bin / env node
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
  { name: 'bump', description: 'does `update` then checks for rust changes, lint issues, updates the dummy file and propmpts to confirm changes before pushing to c-c' },
  { name: 'go', description: 'goes to the comm folder if location is configured in settings' },
  { name: 'submit', description: 'lints all files and submits to phabricator' },
  { name: 'try', description: 'pushes a try run' },
  { name: 'run', description: 'builds and launches thunderbird' },
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
      header: 'Command List',
      content: optionList
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
        await chainCommands(lintDirs.map((dir) => `../mach commlint ${dir} --fix`));
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
        await chainCommands([
          {
            cmd: "hg",
            args: [
              "push-to-try",
              "-s",
              "ssh://hg.mozilla.org/try-comm-central",
              "-m",
              "try: -b o -p all -u mochitest --artifact"
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
    default:
      console.log(usage(sections));
  }
}

async function update() {
  try {
    checkDir();
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