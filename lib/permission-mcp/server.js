#!/usr/bin/env node
'use strict';
// Stdio MCP server exposing one tool, `approve`, used by Claude Code via
// --permission-prompt-tool mcp__jarvis__approve. Each call is forwarded to the
// Mee JARVIS main process over a per-session named pipe; the HUD shows the
// request and the user clicks allow / deny.
//
// Tool input  (from Claude Code): { tool_name, input, tool_use_id }
// Tool output (text JSON):        { behavior:'allow', updatedInput } | { behavior:'deny', message }

const { askBroker } = require('./pipe-client');

const PIPE = process.env.JARVIS_PIPE;
const TOKEN = process.env.JARVIS_TOKEN;
// Main enforces the real timeout; this is only a failsafe a bit later.
const TIMEOUT_MS = (Number(process.env.JARVIS_APPROVAL_TIMEOUT_SEC) || 120) * 1000 + 15000;

const SERVER_INFO = { name: 'jarvis', version: '0.1.0' };
const TOOL = {
  name: 'approve',
  description: 'Ask the Mee JARVIS user (on the HUD screen) to allow or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'server/discover':
      return reply(id, {
        protocolVersion:
          (params && params._meta && params._meta['io.modelcontextprotocol/protocolVersion']) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [TOOL] });
    case 'tools/call': {
      const name = params && params.name;
      if (name !== 'approve') return fail(id, -32602, 'unknown tool ' + name);
      const args = (params && params.arguments) || {};
      const verdict = await askBroker(
        {
          kind: 'permission',
          tool_name: String(args.tool_name || ''),
          input: args.input && typeof args.input === 'object' ? args.input : {},
          tool_use_id: String(args.tool_use_id || ''),
        },
        // 0 = no failsafe: a question to the user waits for the answer
        { pipe: PIPE, token: TOKEN, timeoutMs: args.tool_name === 'AskUserQuestion' ? 0 : TIMEOUT_MS }
      );
      let out;
      if (verdict && verdict.behavior === 'allow') {
        out = { behavior: 'allow', updatedInput: verdict.updatedInput || args.input || {} };
      } else {
        out = { behavior: 'deny', message: String((verdict && verdict.message) || 'ผู้ใช้ปฏิเสธ') };
      }
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    }
    default:
      if (isRequest) {
        if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
        return reply(id, {});
      }
      return undefined;
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) fail(msg.id, -32603, String(err && err.message));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
