/* eslint-disable no-useless-escape */

import util from 'util';
import { exec as execOriginal } from 'child_process';
import { spawn } from 'child_process';
import readlineSync from 'readline-sync';

const exec = util.promisify(execOriginal);

export async function executeCommand(_command, log) {
  console.log(_command)
  const { stdout, stderr } = await exec(_command);
  if (stderr) {
    throw new Error(stderr);
  }
  if(log) {
    console.log(stdout);
  }
  return stdout;
}

export async function run({ cmd, args, capture, cwd, silent }) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const io = spawn(cmd, args, { cwd, stdio: (capture || silent) ? ["inherit", "pipe", "pipe"] : "inherit" });
  const data = [];
  const errorData = [];

  if (capture || silent) {
    io.stdout.on("data", (chunk) => { data.push(chunk); });
    io.stderr.on("data", (chunk) => { errorData.push(chunk); });
    if (!silent) {
      io.stdout.pipe(process.stdout);
    }
    if (!silent) {
      io.stderr.pipe(process.stderr);
    }
  }

  io.on('error', (error) => {
    reject(error, errorData);
  });

  io.on('exit', function (code) {
    if (code > 0) {
      reject(errorData.join("\n"));
    } else {
      resolve(data.join("\n"));
    }
  });

  return promise;
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
      await run({ cmd: "hg", args: ["commit", "--amend", "--message" , message] });
    } catch {
      console.error("Commit failed aborting!");
      process.exit(1);
    }
  }
}

export function getUrls(string) {
  return string.match(/(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/g);
}

export async function mach(command, silent) {
  return run({ cmd: "../mach", args: command.split(" "), silent, capture: silent });
}
