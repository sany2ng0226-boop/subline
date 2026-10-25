import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultSocketPath } from './connection.mjs';

const socket = process.env.SUBLINE_DEV_QA_SOCKET || defaultSocketPath();
console.error(`Subline Dev read-only QA enabled at ${socket}. Captions remain in bounded process memory unless explicitly exported.`);
const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['dev'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, SUBLINE_DEV_QA: '1', SUBLINE_DEV_QA_SOCKET: socket },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
