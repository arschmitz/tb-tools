import { chainCommands } from "../lib/utils.mjs";

export default async function (options, _tryOptions) {
  try {
    const tryOptions = Object.keys(options).map((option) => {
      const name = _tryOptions.find((_option) => _option.name === option).alias;

      if (!name && options[option] !== "false") {
        return `--${option}`;
      } else if (!name) {
        return;
      }

      return [`-${name}`, options[option]].join(" ");
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
}