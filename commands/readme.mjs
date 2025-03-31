import fs from 'fs';
import { writeFile } from 'node:fs/promises';

export default async function () {
  const lines = [
    "<!-- this file is automatiicly generated do not edit -->",
    "# TB Tools - Thunderbird CLI Tools",
    "Simplify tasks related to developing thunderbird.",
    "",
    "Right now these are only things that i have personally used and found useful but happy to add more.",
    "## Instalation",
    "`npm install -g https://github.com/arschmitz/tb-tools`",
    "## Command List",
    "##### <ins>Quick Links</ins>"
  ];
  
  optionList.forEach((option) => {
    lines.push(`- [${option.name}](#${option.name})`)
  });
  optionList.forEach((option) => {
    lines.push(`### ${option.name}`);
    lines.push("---");
    lines.push(option.description);
    lines.push("```bash");
    lines.push(`tb ${option.name}`);
    lines.push("```");
  
    if (subOptions[option.name]) {
      lines.push(`#### Options`);
      lines.push("|option&nbsp;&nbsp;&nbsp;&nbsp;|alias|Description|Default|");
      lines.push("|----|-----------|--|--|");
      subOptions[option.name].forEach((subOption) => {
        lines.push(`|${subOption.name}|${subOption.alias || ""}|${subOption.description.replaceAll("|", "\\|")}|${subOption.defaultValue}|`);
      });
    }
  });
  lines.push("```");
  lines.push(...banner.split(/\n/).map((line) => `                      ${line}`));
  lines.push("```");
  
  if (fs.existsSync("./README.md")) {
    await writeFile("./README.md", lines.join("\n"));
  }
}