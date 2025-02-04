#!/usr/bin / env node

const util = require('util');
const { readFile, writeFile } = require('node:fs/promises');

async function ready_dummy() {
  const contents = await readFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', { encoding: 'utf8' });
  const lines = contents.split(/\n/);
  let dotLine = lines[lines.length - 2];
  const dots = dotLine.match(/\./g)

  if (dots.length === 1) {
    dotLine = '..'
  } else {
    dots.pop()
    dotLine = dots.join('');
  }

  lines[lines.length - 2] = dotLine;

  newContent = lines.join('\n');

  await writeFile('/Users/aschmitz/projects/firefox/mozilla-unified/comm/build/dummy', newContent);

  console.log('Updated Dummy File');
}

ready_dummy();