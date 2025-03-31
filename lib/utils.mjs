import util from 'util';
import { exec as execOriginal } from 'child_process';
import { spawn } from 'child_process';
import readlineSync from 'readline-sync';

const exec = util.promisify(execOriginal);

export async function executeCommand(_command, log) {
  const { stdout, stderr } = await exec(_command);
  if (stderr) {
    throw new Error(stderr);
  }
  if(log) {
    console.log(stdout);
  }
  return stdout;
}

export async function spawnCommand(_command, options) {
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

export async function chainCommands(commands, options) {
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

export function checkDir() {
  const parts = process.cwd().split("/");
  const dirName = parts[parts.length - 1];
  const inDir = dirName === "comm";

  console[inDir ? 'log' : 'error'](`comm${inDir ? "" : " not"} directory found`);
  if (!inDir) {
    throw new Error("comm directory not found");
  }
}

export function mapBooleanOptions(options) {
  Object.keys(options).map((option) => {
    options[option] = options[option] === null ? true : options[option] === "false" ? false : options[option];
  });

  return options;
}

export async function checkForChanges(message) {
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