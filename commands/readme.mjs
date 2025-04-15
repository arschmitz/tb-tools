import fs from 'fs';
import banner from '../lib/banner.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export default async function (optionList, subOptions) {
  const lines = [
    "<!-- this file is automatiicly generated do not edit -->",
    "# TB Tools - Thunderbird CLI Tools",
    "Simplify tasks related to developing thunderbird.",
    "",
    "Right now these are only things that i have personally used and found useful but happy to add more.",
    "## Instalation",
    "`npm install -g https://github.com/arschmitz/tb-tools`",
    "## Configuration",
    "TB Tools uses a configuration `.tb.json` file in your users home directory to enable some features.",
    "This file currently contains credentials for phabricator, and bugzilla. Option defaults and other features may be added in the future.",
    "### Sample Configuration",
`\`\`\`json
{
  "phabricator": {
    "user": "arschmitz",
    "token": "cli-uxdexxxkzvy5m5j7xxgajqunxjhe"
  },
  "bugzilla": {
    "user": "arschmitz",
    "apiKey": "36IrYQ06NddTOnnp4IBwpZjROxxxmvvuqUcv1M2v"
  }
}
\`\`\``,
    "",
    "## Command List",
    "##### <ins>Quick Links</ins>"
  ];
  
  optionList.forEach((option) => {
    lines.push(`- [${option.name}](#${option.name})`)
  });
  lines.push(
`
## Example Development Workflow

1. Start work on a new bug run \`tb create\` and follow prompt
2. Build and open thunderbird \`tb run\`
3. Make changes until ready to commit
4. run lint \`tb lint\`
5. run tests based on your changes \`tb test\`
6. Commit changes \`tb commit\` and follow prompt to generate commit message.
7. Make more changes
8. Add changes to your commit \`tb amend\` selcting new files to add
9. When ready to submit patches to phabricator lint changes, run tests based on changes, push a try run and submit unsubmited comments in phabricator \`tb submit\`

## Sheriff Duty

The land command is your all in one tool for handling pushes in thunderbird. This command integrates with both bugzilla and phabricator to form an all in one solution. Just run the land command and tb-tools will check for rust changes and any accompanying patches. Then pulls all bugs marked for checkin and guide you through the process of landing them 1 at a time including viewing and updating the associated bugs and patches. If run with sanity enabled it will run linting and a build at the end before pushing to comm-central. For detailed workflow and documentation see the land command below.
`)
  optionList.forEach((option) => {
    lines.push(`### ${option.name}`);
    lines.push("---");
    lines.push(option.description);
    lines.push("```bash");
    lines.push(`tb ${option.name}`);
    lines.push("```");
    if (fs.existsSync(path.join("images", `${option.name}.gif`))) {
      lines.push("<br/><br/>");
      lines.push(`![Screen recording of ${option.name}.](/images/${option.name}.gif)`);
    }
  
    if (subOptions[option.name]) {
      lines.push(`#### Options`);
      lines.push("|option|alias|Description|Default|example&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|");
      lines.push("|----|-----------|--|--|---|");
      subOptions[option.name].forEach((subOption) => {
        lines.push(`|--${subOption.name}|${subOption.alias ? "-" + subOption.alias : ""}|${subOption.description.replaceAll("|", "\\|")}|${subOption.defaultValue}|\`tb ${option.name} --${subOption.name}=${subOption.defaultValue}\``);
      });
    }
    lines.push("");
    lines.push("<br/><br/>");
  });
  lines.push("```");
  lines.push(...banner.split(/\n/).map((line) => `                      ${line}`));
  lines.push("```");
  
  if (fs.existsSync("./README.md")) {
    await writeFile("./README.md", lines.join("\n"));
  }
}