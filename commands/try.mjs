import { run, getUrls } from "../lib/utils.mjs";
import { comment } from "../lib/phab.mjs";
import ora from "ora";

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

    const output = await run({
      cmd: "hg",
      args: [
        "push-to-try",
        "-s",
        "ssh://hg.mozilla.org/try-comm-central",
        "-m",
        `try: ${tryOptions}`
      ],
      capture: true,
    });

    const urls = getUrls(output);
    const tryUrl = urls[urls.length - 1];

    if (tryOptions.comment) {
      const spinner = new ora({
        text: "Posting comment to phabricator"
      }).start();
      try {
        await comment(`try: ${tryUrl}`);
        spinner.succeed();
      } catch (error) {
        spinner.fail();
        throw error;
      }
    }

    return tryUrl;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}