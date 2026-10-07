import path from "node:path";

export function normalizeMachCommand(command, platform = process.platform) {
  if (platform !== "win32" || path.basename(String(command.cmd).replaceAll("\\", "/")) !== "mach") return command;
  return { ...command, cmd: process.env.TB_MACH_PYTHON || "python", args: [command.cmd, ...(command.args || [])] };
}
