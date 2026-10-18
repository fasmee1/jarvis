'use strict';
// Append-only audit log of every tool call: <project>/.jarvis/audit.log (JSONL).

const fs = require('fs');
const path = require('path');

const MAX_INPUT = 4000;

function truncate(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s && s.length > MAX_INPUT ? s.slice(0, MAX_INPUT) + '…(truncated)' : s;
}

class AuditLog {
  constructor(cwd) {
    this.file = cwd ? path.join(cwd, '.jarvis', 'audit.log') : null;
  }

  write(entry) {
    if (!this.file) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session: entry.session || null,
      tool: entry.tool,
      tool_use_id: entry.tool_use_id || null,
      input: truncate(entry.input),
      decision: entry.decision,
      source: entry.source || null,
      note: entry.note || undefined,
    });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line + '\n', 'utf8');
    } catch { /* never let logging break the app */ }
  }
}

module.exports = { AuditLog };
