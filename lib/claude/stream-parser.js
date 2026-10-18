'use strict';
// Newline-delimited JSON parser for `claude --output-format stream-json`.
// Chunks may split a line anywhere (even inside a multi-byte UTF-8 char),
// so we decode with a streaming TextDecoder and buffer until '\n'.

const MAX_LINE = 64 * 1024 * 1024; // guard against runaway lines without newline

class StreamJsonParser {
  constructor({ onEvent, onBadLine } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onBadLine = onBadLine || (() => {});
    this.decoder = new TextDecoder('utf-8');
    this.buf = '';
  }

  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this._line(line);
    }
    if (this.buf.length > MAX_LINE) {
      this.onBadLine(this.buf.slice(0, 200) + '…', new Error('line too long'));
      this.buf = '';
    }
  }

  end() {
    this.buf += this.decoder.decode();
    if (this.buf.trim()) this._line(this.buf);
    this.buf = '';
  }

  _line(line) {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (err) {
      this.onBadLine(line, err);
      return;
    }
    if (!ev || typeof ev !== 'object') {
      this.onBadLine(line, new Error('not an object'));
      return;
    }
    this.onEvent(ev);
  }
}

module.exports = { StreamJsonParser };
