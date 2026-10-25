import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const defaultSocketPath = () => path.join(os.tmpdir(), `subline-dev-qa-${process.getuid?.() ?? 'local'}`, 'dev.sock');

export function readDev(method, args = {}, socketPath = process.env.SUBLINE_DEV_QA_SOCKET || defaultSocketPath()) {
  if (!['identity', 'snapshot', 'events'].includes(method)) return Promise.reject(new Error('Read-only method required'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let received = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(7000, () => finish(new Error('Dev QA response timed out')));
    socket.once('error', error => finish(new Error(`Dev QA unavailable at ${socketPath}: ${error.message}`)));
    socket.once('connect', () => socket.write(JSON.stringify({ ...args, id: 1, method }) + '\n'));
    socket.on('data', chunk => {
      received += chunk.toString();
      if (Buffer.byteLength(received) > 8 * 1024 * 1024) return finish(new Error('Dev QA response too large'));
      const end = received.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end));
        if (response.id !== 1) throw new Error('Dev QA response ID mismatch');
        if (response.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once('end', () => finish(new Error('Dev QA ended without a response')));
  });
}
