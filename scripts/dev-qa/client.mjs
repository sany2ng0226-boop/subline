import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const [command = 'snapshot', ...rest] = process.argv.slice(2);
const commands = { identity: 'subline_identity', snapshot: 'subline_snapshot', events: 'subline_events' };
const client = new Client({ name: 'subline-qa-local-client', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env } });
const read = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (response.isError) throw new Error(text);
  return JSON.parse(text);
};
try {
  await client.connect(transport);
  if (command === 'list') console.log(JSON.stringify(await client.listTools(), null, 2));
  else if (command === 'capture') {
    const seconds = Number(rest[0] ?? 120);
    const output = rest[1];
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600 || !output || !path.isAbsolute(output)) throw new Error('capture requires seconds (1–600) and an absolute output directory');
    await mkdir(output, { recursive: true });
    const stream = createWriteStream(path.join(output, 'trace.jsonl'), { flags: 'wx', mode: 0o600 });
    let writeError;
    stream.on('error', error => { writeError = error; });
    const write = value => {
      if (writeError) throw writeError;
      stream.write(JSON.stringify({ capturedAt: new Date().toISOString(), ...value }) + '\n');
    };
    let cursor = 0;
    const started = Date.now();
    let stopped = false;
    process.on('SIGINT', () => { stopped = true; });
    try {
      write({ type: 'identity', data: await read('subline_identity') });
      do {
        const data = await read('subline_events', { after: cursor, limit: 1000 });
        write({ type: 'events', data });
        const events = data.events ?? [];
        if (events.length) cursor = events.at(-1).seq;
        write({ type: 'snapshot', data: await read('subline_snapshot') });
        if (stopped || Date.now() - started >= seconds * 1000) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (!stopped);
    } finally {
      await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
      if (writeError) throw writeError;
    }
    console.log(JSON.stringify({ output: path.join(output, 'trace.jsonl'), durationSeconds: (Date.now() - started) / 1000, cursor }));
  } else if (commands[command]) {
    const args = command === 'events' ? { after: Number(rest[0] ?? 0), limit: Number(rest[1] ?? 200) } : {};
    console.log(JSON.stringify(await read(commands[command], args), null, 2));
  } else throw new Error('Use identity, snapshot, events [after] [limit], list, or capture [seconds] [absolute directory]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await client.close(); }
