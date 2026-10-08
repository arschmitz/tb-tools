const { app, utilityProcess } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-embedding-smoke-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
app.whenReady().then(() => {
  const worker = utilityProcess.fork(path.join(__dirname, '../commands/knowledge/embedding-worker.mjs'),
    [JSON.stringify({cache:process.argv[2] || path.join(os.homedir(), '.tb-tools/knowledge/models'),model:'Xenova/all-MiniLM-L6-v2'})], {stdio:'pipe'});
  worker.stderr.on('data', data => process.stderr.write(data));
  worker.stdout.on('data', data => process.stdout.write(data));
  const timeout = setTimeout(() => { console.error('timed out'); worker.kill(); app.exit(1); }, 55000);
  worker.on('message', message => {
    if (message.error) { console.error(message.error); clearTimeout(timeout); worker.kill(); app.exit(1); }
    if (message.ready) worker.postMessage({id:1,texts:Array.from({length:32},()=> 'Review patch comments and code replacement. '.repeat(40))});
    if (message.vectors) { const valid = message.vectors.length === 32 && message.vectors.every(vector => vector.length === 384 && vector.every(Number.isFinite)); console.log(JSON.stringify({count:message.vectors.length,dimensions:message.vectors[0].length,finite:message.vectors.flat().every(Number.isFinite)})); clearTimeout(timeout); worker.kill(); app.exit(valid ? 0 : 1); }
  });
  worker.on('exit', code => { if (code) {console.error('worker exited',code); app.exit(1);} });
});
