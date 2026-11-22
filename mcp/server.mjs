#!/usr/bin/env node
// ID-JAG Standalone LAB companion MCP server (stdio).
//
// Exposes the lab's HTTP routes as MCP tools so an MCP client can drive the
// same surface the Postman collection covers. The lab stays the single source
// of state (sessions, tokens); this server is a thin proxy.
//
// Configuration:
//   IDJAG_LAB_BASE  base URL of a running ID-JAG Standalone LAB (default http://localhost:4720)
//
// Run: node mcp/server.mjs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.IDJAG_LAB_BASE || 'http://localhost:4720').replace(/\/+$/, '');
const ORIGIN = process.env.IDJAG_LAB_ORIGIN || 'http://localhost:4720';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: ORIGIN,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const text = (r) => ({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });

const server = new McpServer({
  name: 'idjag-standalone-lab',
  version: '0.1.0',
  title: 'ID-JAG Standalone LAB tools',
  description: 'Drive ID-JAG Standalone LAB: health and backend status, token decode/inspect, the negative-test catalog, and the live flow steps (issue by RFC 8693 exchange, redeem by RFC 7523, call the MCP server) when a browser sign-in session exists on the lab.',
});

server.registerTool('idjag_health', {
  title: 'Lab health',
  description: 'Check the lab is running, and its mode (mock/live) and setup state.',
  inputSchema: {},
}, async () => text(await call('/api/health')));

server.registerTool('idjag_backends', {
  title: 'Backend status',
  description: 'Reachability of the configured backends (resource AS, MCP sample, PingFederate).',
  inputSchema: {},
}, async () => text(await call('/api/id-jag-playground/backends')));

server.registerTool('idjag_decode_token', {
  title: 'Decode and inspect a token',
  description: 'Decode a pasted JWT (ID-JAG, access token, ID token) and run the lab\'s structural checks over it. No session needed; nothing leaves the lab.',
  inputSchema: { token: z.string().describe('Compact JWT to decode and check') },
}, async ({ token }) => text(await call('/api/inspect/decode', { method: 'POST', body: { token } })));

server.registerTool('idjag_negative_catalog', {
  title: 'Negative tests catalog',
  description: 'List the playground\'s negative tests with the OAuth error each one expects.',
  inputSchema: {},
}, async () => text(await call('/api/id-jag-playground/negative')));

server.registerTool('idjag_negative_run', {
  title: 'Run a negative test',
  description: 'Run one negative test from the catalog (e.g. "replay", "bad-signature", "client-mismatch"). Needs a signed-in session with an issued ID-JAG on the lab; otherwise the answer says it was skipped.',
  inputSchema: { id: z.string().describe('Negative test id from the catalog') },
}, async ({ id }) => text(await call(`/api/id-jag-playground/negative/${encodeURIComponent(id)}`, { method: 'POST', body: {} })));

server.registerTool('idjag_issue', {
  title: 'Issue an ID-JAG (RFC 8693 exchange)',
  description: 'Run the exchange leg of the flow. LIVE: acts on the lab\'s browser sign-in session; answers 401/403 without one. Every token stays server-side; the answer carries decoded claims only.',
  inputSchema: { mode: z.enum(['pf-as', 'pf-pf', 'gateway-redeem', 'aws-agentcore']).optional().describe('Playground mode; default is the lab\'s own default') },
}, async ({ mode }) => text(await call('/api/id-jag-playground/issue', { method: 'POST', body: mode ? { mode } : {} })));

server.registerTool('idjag_redeem', {
  title: 'Redeem the ID-JAG (RFC 7523 JWT bearer)',
  description: 'Redeem the issued ID-JAG at the resource authorization server for an access token. Needs the issue step first (409 no_id_jag otherwise).',
  inputSchema: { scope: z.string().optional().describe('Optional space-separated scope narrowing; must be within the ID-JAG\'s scopes') },
}, async ({ scope }) => text(await call('/api/id-jag-playground/redeem', { method: 'POST', body: scope ? { scope } : {} })));

server.registerTool('idjag_call_mcp', {
  title: 'Call the MCP server with the redeemed token',
  description: 'One JSON-RPC request to the configured MCP server using the redeemed access token: tools/list by default, or tools/call for a named tool.',
  inputSchema: {
    tool: z.string().optional().describe('Tool name to call; omit for tools/list'),
    args: z.record(z.string(), z.unknown()).optional().describe('Arguments for the tool call'),
  },
}, async ({ tool, args }) => text(await call('/api/id-jag-playground/call', { method: 'POST', body: { tool, arguments: args } })));

const transport = new StdioServerTransport();
await server.connect(transport);
