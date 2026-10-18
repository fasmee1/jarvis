'use strict';
// Incremental speech segmenter. Thai often has no full stops, so a segment ends
// at whichever comes first: . ! ? ฯ (followed by whitespace), a newline, or a
// space once the segment is longer than `softLimit` characters.

class SpeechSegmenter {
  constructor(onSegment, { softLimit = 120, hardLimit = 300 } = {}) {
    this.onSegment = onSegment;
    this.softLimit = softLimit;
    this.hardLimit = hardLimit;
    this.buf = '';
  }

  push(text) {
    this.buf += text;
    this._scan(false);
  }

  flush() {
    this._scan(true);
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.onSegment(rest);
  }

  reset() {
    this.buf = '';
  }

  _scan(final) {
    let start = 0;
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      const next = b[i + 1];
      const len = i - start + 1;
      let cut = -1;
      if (ch === '\n') cut = i;
      else if ('.!?ฯ'.includes(ch)) {
        if (next === undefined) {
          if (final) cut = i + 1;
        } else if (/\s/.test(next)) cut = i + 1;
      } else if (/\s/.test(ch) && len > this.softLimit) cut = i;
      else if (len >= this.hardLimit) cut = i + 1;

      if (cut >= 0) {
        const seg = b.slice(start, cut).trim();
        if (seg) this.onSegment(seg);
        start = cut;
      }
    }
    this.buf = b.slice(start);
  }
}

module.exports = { SpeechSegmenter };
