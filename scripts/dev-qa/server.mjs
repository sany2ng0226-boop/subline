import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readDev } from './connection.mjs';

const server = new McpServer({ name: 'subline-dev-qa', version: '0.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = async (method, args = {}) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await readDev(method, args)) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
};
server.registerTool('subline_identity', {
  description: 'Read the exact opted-in Subline Dev app identity. Never launches an app.', annotations,
  inputSchema: {},
}, () => result('identity'));
server.registerTool('subline_snapshot', {
  description: 'Read current Dev pipeline/settings and a fresh renderer transcript/viewport snapshot. Check freshness/error fields before drawing conclusions.',
  annotations, inputSchema: {},
}, () => result('snapshot'));
server.registerTool('subline_events', {
  description: 'Read bounded diagnostic events after a sequence cursor: audio levels, model decode, ASR fragments, assembled finals, renderer delivery. Check cursor loss before asserting completeness. Contains private live captions; no PCM.',
  annotations,
  inputSchema: { after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() },
}, args => result('events', args));
await server.connect(new StdioServerTransport());
