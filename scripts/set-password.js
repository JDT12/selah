// Interactively set (or reset) the login password. Usage: npm run set-password
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { setPassword, passwordProblem, logEvent } from '../server/auth.js';

let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });

function ask(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    muted = true;
    rl.question('', (a) => { muted = false; process.stdout.write('\n'); resolve(a); });
  });
}

const pw = await ask('New password: ');
const problem = await passwordProblem(pw);
if (problem) {
  console.error(problem);
  process.exit(1);
}
if ((await ask('Confirm password: ')) !== pw) {
  console.error('Passwords do not match.');
  process.exit(1);
}
rl.close();
await setPassword(pw);
logEvent('password-changed', null, { from: 'server' });
console.log('Password set. All existing sessions were signed out.');
