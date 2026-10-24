'use strict';
// What the stream-json events say about the conversation's size and its subagents (verified on
// claude 2.1.310): the last main-thread assistant message's usage is the context in use,
// `compact_boundary` says a compaction happened, `task_*` system events describe subagents.

const DEFAULT_WINDOW = 200000;
const MAX_AGENTS = 30;

const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);

/** Tokens the next request will carry: everything in the prompt, cached or not. */
function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
  return n > 0 ? n : null;
}

/** Context window of the model(s) in a result event's modelUsage, or null when it isn't reported. */
function windowFromResult(ev) {
  const mu = ev && ev.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  let best = 0;
  for (const m of Object.values(mu)) if (m && num(m.contextWindow) > best) best = m.contextWindow;
  return best || null;
}

/**
 * Should JARVIS compact now? `at` is a percent (0 = never). `lastPost` is the size right after the
 * previous automatic compaction: if that was already near the limit, wait until the context has
 * grown by a tenth of the window before trying again, instead of compacting on every turn.
 */
function shouldAutoCompact({ used, window = DEFAULT_WINDOW, at, lastPost = 0 }) {
  if (!at || !used || !window) return false;
  if (used < (window * at) / 100) return false;
  return !lastPost || used >= lastPost + window / 10;
}

/** Subagents ("Task" tool) of the current turn, built from the CLI's task_* events. */
class SubagentTracker {
  constructor() {
    this.agents = new Map(); // task_id -> agent
  }

  reset() {
    const had = this.agents.size > 0;
    this.agents.clear();
    return had;
  }

  /** @returns {boolean} true when the list changed */
  handle(ev) {
    if (!ev || ev.type !== 'system' || typeof ev.task_id !== 'string') return false;
    let a = this.agents.get(ev.task_id);
    switch (ev.subtype) {
      case 'task_started':
        if (ev.task_type && ev.task_type !== 'local_agent') return false; // shell / workflow tasks are not subagents
        a = { id: ev.task_id, toolUseId: ev.tool_use_id || null, title: String(ev.description || '').slice(0, 200), type: String(ev.subagent_type || '').slice(0, 60), status: 'running', tools: 0, tokens: 0, lastTool: '', startedAt: Date.now(), endedAt: null };
        this.agents.set(ev.task_id, a);
        while (this.agents.size > MAX_AGENTS) this.agents.delete(this.agents.keys().next().value);
        return true;
      case 'task_progress': {
        if (!a) return false;
        const u = ev.usage || {};
        a.tools = num(u.tool_uses) || a.tools;
        a.tokens = num(u.total_tokens) || a.tokens;
        if (typeof ev.last_tool_name === 'string') a.lastTool = ev.last_tool_name.slice(0, 60);
        if (typeof ev.description === 'string') a.activity = ev.description.slice(0, 200);
        return true;
      }
      case 'task_updated': {
        const st = ev.patch && ev.patch.status;
        if (!a || typeof st !== 'string' || a.status === st) return false;
        a.status = st;
        if (st !== 'running') a.endedAt = Date.now();
        return true;
      }
      case 'task_notification':
        if (!a || (ev.status && a.status === ev.status)) return false;
        a.status = String(ev.status || a.status);
        a.endedAt = a.endedAt || Date.now();
        return true;
      default:
        return false;
    }
  }

  list() {
    return [...this.agents.values()].map((a) => ({ ...a }));
  }
}

module.exports = { contextTokens, windowFromResult, shouldAutoCompact, SubagentTracker, DEFAULT_WINDOW };
