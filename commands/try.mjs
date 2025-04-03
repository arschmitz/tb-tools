import { chainCommands, getUrls } from "../lib/utils.mjs";
import { comment } from "../lib/phab.mjs";

const validTryOptions = ['unit-tests', 'build-types', 'artifact', 'platform'];

export default async function (options, _tryOptions) {
  try {
    const tryOptions = validTryOptions.reduce((collection, option) => {
      const alias = _tryOptions.find((_option) => _option.name === option).alias;

      if (!alias && options[option] !== "false") {
        collection.push(`--${option}`);
      } else if (alias && options[option]) {
        collection.push([`-${alias}`, options[option]].join(" "));
      }

      return collection;
    }, []).join(" ");

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