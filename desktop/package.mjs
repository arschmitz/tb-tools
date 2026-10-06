import path from "node:path";
import { packager } from "@electron/packager";

const root = path.resolve(import.meta.dirname, "..");
const output = await packager({
  dir: root,
  name: "Thunderbird-Commands",
  out: path.join(root, "dist"),
  overwrite: true,
  asar: true,
  icon: ["darwin", "win32"].includes(process.platform)
    ? path.join(root, "desktop", process.platform === "darwin" ? "icon.icns" : "icon.ico")
    : undefined,
  ignore: [
    /^\/test(?:\/|$)/,
    /^\/dist(?:\/|$)/,
    /^\/(?:AGENTS|AI_USAGE_AUDIT|TRY_STATUS_AUDIT)\.md$/,
    /^\/\.env(?:$|\.)/,
  ],
});

process.stdout.write(`${output.join("\n")}\n`);
