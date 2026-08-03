/* eslint-disable no-useless-escape */

import util from 'util';
import ora from 'ora';
import { displayJokes } from './joke.mjs';
import { exec as execOriginal } from 'child_process';
import { spawn } from 'child_process';
import readlineSync from 'readline-sync';
import path from 'path';

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

export async function run({
  cmd,
  args,
  capture,
  cwd,
  silent,
  timeoutMs,
  killProcessGroup = false,
}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  args ||= [];
  const shouldKillProcessGroup = Boolean(killProcessGroup) &&
    process.platform !== "win32";
  const io = spawn(cmd, args, {
    cwd,
    detached: shouldKillProcessGroup,
    stdio: (capture || silent) ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  const data = [];
  const errorData = [];
  let timedOut = false;
  let settled = false;
  let killTimer = null;
  const killChild = (signal) => {
    if (shouldKillProcessGroup && io.pid) {
      try {
        process.kill(-io.pid, signal);
        return;
      } catch {
        // Fall back to killing the direct child if the process group is gone.
      }
    }

    io.kill(signal);
  };
  const timer = Number(timeoutMs) > 0
    ? setTimeout(() => {
        timedOut = true;
        killChild("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) {
            killChild("SIGKILL");
          }
        }, 5000);
        killTimer.unref?.();
      }, Number(timeoutMs))
    : null;

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
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    error.stderr = Buffer.concat(errorData).toString();
    reject(error);
  });

  io.on('exit', function (code, signal) {
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    const stdout = Buffer.concat(data).toString();
    const stderr = Buffer.concat(errorData).toString();

    if (timedOut) {
      const error = new Error(`${cmd} timed out after ${Number(timeoutMs)}ms`);
      error.code = "ETIMEDOUT";
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    } else if (code > 0 || signal) {
      const error = new Error(stderr || `${cmd} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    } else {
      resolve(stdout);
    }
  });

  return promise;
}

export function checkDir() {
  const parts = process.cwd().split(path.sep);
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
  const status = await run({
    cmd: "git",
    args: ["status", "--porcelain"],
    capture: true,
    silent: true,
  });

  if (status.trim()) {
    console.warn(message);
    const amend = readlineSync.keyInYNStrict("Amend commit? [y/n]:", { guide: false });

    if (!amend) {
      throw new Error(message);
    }

    try {
      await run({ cmd: "git", args: ["add", "-A"] });
      await run({ cmd: "git", args: ["commit", "--amend", "--no-edit"] });
    } catch (error) {
      throw new Error("Commit failed aborting!", { cause: error });
    }
  }
}

export function getUrls(string) {
  return string.match(/(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/g);
}

export async function mach(command, silent) {
  const args = Array.isArray(command) ? command : command.split(" ");
  return run({ cmd: path.join("..", "mach"), args, silent, capture: silent });
}

export async function machBuild() {
  const spinner = ora({
    text: "Building"
  }).start();
  try {
    const promise = mach("build", true);
    await displayJokes(promise);
    spinner.succeed();
  } catch (error) {
    spinner.fail();
    console.error(error);
  }
}
