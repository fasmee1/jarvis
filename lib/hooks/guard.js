#!/usr/bin/env node
'use strict';
// PreToolUse hook installed by Mee JARVIS (via --settings, never written into
// the user's own settings). Blocks catastrophic commands and forces an on-screen
// confirmation for firmware uploads and admin installs — in every permission
// mode, including bypassPermissions.
//
// Env: JARVIS_GUARD_CONFIG (path to JSON), JARVIS_PIPE, JARVIS_TOKEN.

const fs = require('fs');
const { evaluate, evaluatePlan } = require('./guard-rules');
const { askBroker } = require('../permission-mcp/pipe-client');

function out(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return; // nothing we can judge; let Claude Code's normal rules apply
  }
  // Plan mode is read-only no matter what the guard settings or allow-rules say.
  const mode = ev.permission_mode || process.env.JARVIS_PERMISSION_MODE;
  if (mode === 'plan') {
    const plan = evaluatePlan(ev.tool_name, ev.tool_input);
    if (plan.action === 'block') {
      out('deny', `JARVIS plan-mode: ${plan.reason}`);
      return;
    }
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(process.env.JARVIS_GUARD_CONFIG, 'utf8'));
  } catch {
    return;
  }
  const verdict = evaluate(ev.tool_name, ev.tool_input, cfg);
  if (verdict.action === 'block') {
    out('deny', `JARVIS guard: ${verdict.reason} (pattern: ${verdict.pattern}) ผู้ใช้ปิดตัวกันนี้ได้ใน Settings`);
    return;
  }
  if (verdict.action === 'ask') {
    const timeoutMs = (Number(process.env.JARVIS_APPROVAL_TIMEOUT_SEC) || 120) * 1000 + 5000;
    const d = await askBroker(
      {
        kind: 'guard',
        tool_name: ev.tool_name,
        input: ev.tool_input || {},
        tool_use_id: ev.tool_use_id || '',
        reason: verdict.reason,
      },
      { pipe: process.env.JARVIS_PIPE, token: process.env.JARVIS_TOKEN, timeoutMs }
    );
    if (d.behavior === 'allow') out('allow', 'ผู้ใช้อนุญาตบนหน้าจอ JARVIS');
    else out('deny', `JARVIS guard: ${d.message || 'ผู้ใช้ปฏิเสธ'}`);
  }
}

main().catch(() => process.exit(0));
