// Runs a command with Node 24, for launchers that start servers without a
// login shell (the Claude app's preview, editors). This Mac's default Node is
// 20, which can't run the API's TypeScript files: the API would crash at
// start, and the website would show every request as failed.
//
//   node scripts/node24.mjs npm run dev:api:local
//
// Plain JavaScript that any Node runs, so it can start where the default one is.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const major = v => Number(v.replace(/^v/, '').split('.')[0]);
let bin = major(process.version) >= 24 ? null : undefined;
if (bin === undefined) {
  const versions = join(homedir(), '.nvm', 'versions', 'node');
  const found = existsSync(versions) ? readdirSync(versions).filter(v => major(v) === 24).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  bin = found[0] ? join(versions, found[0], 'bin') : undefined;
}
if (bin === undefined) {
  console.error(`Graphinity needs Node 24 (found ${process.version}). Install it with: nvm install 24`);
  process.exit(1);
}
const [command, ...args] = process.argv.slice(2);
if (!command) { console.error('Usage: node scripts/node24.mjs <command> [args…]'); process.exit(2); }
const env = bin ? { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } : process.env;
const child = spawn(bin ? join(bin, command) : command, args, { stdio: 'inherit', env });
// Pass stop signals on, so stopping the launcher stops the server.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
