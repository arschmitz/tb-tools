import { chainCommands, getUrls } from "../lib/utils.mjs";
import { comment } from "../lib/phab.mjs";

export default async function (options, _tryOptions) {
  try {
    const tryOptions = Object.keys(options).map((option) => {
      const alias = _tryOptions.find((_option) => _option.name === option).alias;

      if (!alias && options[option] !== "false") {
        return `--${option}`;
      } else if (!alias) {
        return;
      }

      return [`-${alias}`, options[option]].join(" ");
    }).join(" ");

    const output = await chainCommands([
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

    const urls = getUrls(output.data);
    console.log("urls", urls);
    console.log(`try: ${urls[urls.length - 1]}`);

    if (tryOptions.comment) {
      await comment(`try: test`);
    }

    return urls[urls.length - 1];
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}