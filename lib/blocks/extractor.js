'use strict';
// Streaming splitter for assistant text. Feed text deltas as they arrive; it
// emits:
//   {type:'text', text}                     prose outside any fence (speakable)
//   {type:'code', lang, code}               ordinary fenced code (display only)
//   {type:'block', kind, data|code, raw}    ```jarvis-<kind> that passed schema
//   {type:'block-error', kind, error, raw}  ```jarvis-<kind> that failed
// Prose is emitted as soon as we know the current line can't be a fence line,
// so TTS can start before the line finishes.

const { SCHEMAS, CODE_KINDS } = require('./schemas');
const { validate } = require('./validate');

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const MAYBE_FENCE_PREFIX = /^ {0,3}(`{0,3}|~{0,3})$/;
const FENCE_START = /^ {0,3}(`{3}|~{3})/;

class BlockExtractor {
  constructor(onItem) {
    this.onItem = onItem;
    this.reset();
  }

  reset() {
    this.line = ''; // current, not yet fully processed line
    this.committed = false; // part of this line already emitted as prose
    this.fence = null; // {marker, lang, lines:[]}
  }

  push(text) {
    // Prose is coalesced into one item per push() instead of one per char.
    this.out = '';
    for (const ch of text) {
      if (ch === '\n') {
        this._endLine();
        continue;
      }
      this.line += ch;
      if (!this.fence) this._maybeEmitPartial();
    }
    this._flushOut();
  }

  _flushOut() {
    const t = this.out;
    this.out = null;
    if (t) this.onItem({ type: 'text', text: t });
  }

  end() {
    // A closing fence with no trailing newline is still a closing fence.
    if (this.fence && this.line) {
      this._endLine();
    }
    if (this.line) {
      if (this.fence) this.fence.lines.push(this.line);
      else if (!this.committed && FENCE_OPEN.test(this.line)) { /* lone opener: drop */ }
      else this._emitText(this.line);
    }
    if (this.fence) {
      const { lang, lines } = this.fence;
      const raw = lines.join('\n');
      if (lang.startsWith('jarvis-')) {
        this._emitItem({ type: 'block-error', kind: lang.slice(7), error: 'บล็อกไม่ได้ปิดด้วย ```', raw });
      } else {
        this._emitItem({ type: 'code', lang, code: raw });
      }
    }
    this.reset();
  }

  _maybeEmitPartial() {
    if (this.committed) {
      // Hold a trailing backtick run: models sometimes start "```jarvis-x" mid-line.
      const tail = this.line.match(/`{1,3}[\w.+-]*$/);
      const cut = tail ? tail.index : this.line.length;
      this._emitText(this.line.slice(0, cut));
      this.line = this.line.slice(cut);
      return;
    }
    if (MAYBE_FENCE_PREFIX.test(this.line) || FENCE_START.test(this.line)) return; // wait for the rest
    this._emitText(this.line);
    this.line = '';
    this.committed = true;
  }

  _endLine() {
    const line = this.line;
    this.line = '';
    const wasCommitted = this.committed;
    this.committed = false;

    if (this.fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === this.fence.marker[0] && close[1].length >= this.fence.marker.length) {
        this._closeFence();
      } else {
        this.fence.lines.push(line);
      }
      return;
    }
    if (!wasCommitted) {
      const m = line.match(FENCE_OPEN);
      if (m) {
        this.fence = { marker: m[1], lang: (m[2] || '').toLowerCase(), lines: [] };
        return;
      }
    } else {
      const m = line.match(/^```(jarvis-[\w-]+)\s*$/i);
      if (m) {
        this._emitText('\n');
        this.fence = { marker: '```', lang: m[1].toLowerCase(), lines: [] };
        return;
      }
    }
    this._emitText(line + '\n');
  }

  _closeFence() {
    const { lang, lines } = this.fence;
    this.fence = null;
    const raw = lines.join('\n');
    if (!lang.startsWith('jarvis-')) {
      this._emitItem({ type: 'code', lang, code: raw });
      return;
    }
    const kind = lang.slice(7);
    if (CODE_KINDS.has(kind)) {
      this._emitItem({ type: 'block', kind, code: raw, raw });
      return;
    }
    const schema = SCHEMAS[kind];
    if (!schema) {
      this._emitItem({ type: 'block-error', kind, error: `ไม่รู้จักบล็อกชนิด "${kind}"`, raw });
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      this._emitItem({ type: 'block-error', kind, error: 'JSON ไม่ถูกต้อง: ' + err.message, raw });
      return;
    }
    const errs = validate(schema, data);
    if (errs.length) {
      this._emitItem({ type: 'block-error', kind, error: errs.slice(0, 5).join('; '), raw });
      return;
    }
    this._emitItem({ type: 'block', kind, data, raw });
  }

  _emitText(text) {
    if (!text) return;
    if (this.out != null) this.out += text;
    else this.onItem({ type: 'text', text });
  }

  _emitItem(item) {
    // Keep ordering: flush pending prose before a block/code item.
    if (this.out) {
      this.onItem({ type: 'text', text: this.out });
      this.out = '';
    }
    this.onItem(item);
  }
}

module.exports = { BlockExtractor };
