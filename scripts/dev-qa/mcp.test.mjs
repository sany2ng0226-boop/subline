import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readDev } from './connection.mjs';

test('official MCP client lists only read tools and reads Unicode through Unix socket', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-mcp-'));
  const socket = path.join(dir, 'dev.sock');
  const requests = [];
  const server = net.createServer(connection => {
    let input = '';
    connection.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input);
      requests.push(request);
      const output = Buffer.from(JSON.stringify({ id: request.id, result: { method: request.method, text: '挨拶が出来る', after: request.after } }) + '\n');
      const cut = output.indexOf(Buffer.from('挨')) + 1;
      connection.write(output.subarray(0, cut));
      setTimeout(() => connection.end(output.subarray(cut)), 10);
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const client = new Client({ name: 'qa-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env, SUBLINE_DEV_QA_SOCKET: socket } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['subline_events', 'subline_identity', 'subline_snapshot']);
    assert.ok(tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
    const response = await client.callTool({ name: 'subline_events', arguments: { after: 7, limit: 10 } });
    assert.equal(JSON.parse(response.content[0].text).text, '挨拶が出来る');
    assert.equal(requests[0].method, 'events');
    assert.equal(requests[0].after, 7);
    const invalid = await client.callTool({ name: 'subline_events', arguments: { after: -1 } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 1);
    const unknown = await client.callTool({ name: 'start_recording', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(requests.length, 1);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true });
  }
});

test('socket client rejects write methods before connecting', async () => {
  await assert.rejects(readDev('start', {}, '/nonexistent.sock'), /Read-only/);
});

test('unavailable Dev returns MCP error, not invented empty success', async () => {
  const client = new Client({ name: 'qa-unavailable-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env, SUBLINE_DEV_QA_SOCKET: '/tmp/subline-qa-test-does-not-exist.sock' } });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'subline_snapshot', arguments: {} });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /unavailable/);
  } finally { await client.close(); }
});
