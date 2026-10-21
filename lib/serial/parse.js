'use strict';
// Pure helpers for serial monitor lines: pull numbers out of "23.5", "23.5,60" or "temp:23.5 hum:60",
// keep a ring buffer, and turn it into a ```jarvis-result chart payload.

const MAX_LINES = 300;
const MAX_LINE_LEN = 200;
const MAX_SERIES = 6;
const NUM = /(-?\d+(?:\.\d+)?)/g;
const LABELED = /([A-Za-z_][\w ]{0,19})\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;

/** @returns {{name: string, value: number}[]} labelled when the line says "name: value", else s1, s2 … */
function parseLine(line) {
  const text = String(line || '').slice(0, MAX_LINE_LEN);
  const out = [];
  for (const m of text.matchAll(LABELED)) out.push({ name: m[1].trim(), value: parseFloat(m[2]) });
  if (out.length) return out.slice(0, MAX_SERIES);
  const nums = text.match(NUM) || [];
  // a line of prose with one stray number ("Booting v2") is not a reading: need the line to be mostly numeric
  const rest = text.replace(NUM, '').replace(/[\s,;|\t]/g, '');
  if (!nums.length || rest.length > 0) return [];
  return nums.slice(0, MAX_SERIES).map((n, i) => ({ name: `s${i + 1}`, value: parseFloat(n) }));
}

class SerialBuffer {
  constructor(max = MAX_LINES) {
    this.max = max;
    this.lines = [];
    this.series = new Map(); // name -> number[] (same length cap)
  }

  push(line) {
    const text = String(line || '').slice(0, MAX_LINE_LEN);
    this.lines.push(text);
    if (this.lines.length > this.max) this.lines.shift();
    for (const { name, value } of parseLine(text)) {
      if (!this.series.has(name)) {
        if (this.series.size >= MAX_SERIES) continue;
        this.series.set(name, []);
      }
      const arr = this.series.get(name);
      arr.push(value);
      if (arr.length > this.max) arr.shift();
    }
  }

  clear() {
    this.lines = [];
    this.series.clear();
  }

  last(n = 10) {
    return this.lines.slice(-n);
  }

  /** A jarvis-result chart of the last `n` samples per series, or a text result when nothing numeric arrived. */
  toResult({ n = 60, port = '' } = {}) {
    const title = port ? `Serial ${port}` : 'Serial';
    if (!this.series.size) {
      const tail = this.last(15);
      return {
        type: 'text',
        title,
        spokenSummary: tail.length ? 'ยังไม่พบค่าที่เป็นตัวเลขจากบอร์ด แสดงข้อความล่าสุดบนจอแล้ว' : 'ยังไม่มีข้อมูลจากบอร์ด',
        markdown: tail.length ? tail.map((l) => `    ${l}`).join('\n') : 'ยังไม่ได้รับข้อมูล',
      };
    }
    const series = [...this.series].map(([name, values]) => ({ name, values: values.slice(-n) }));
    const len = Math.max(...series.map((s) => s.values.length));
    const latest = series.map((s) => `${s.name} ${s.values[s.values.length - 1]}`).join(' ');
    return {
      type: 'chart',
      title,
      spokenSummary: `ค่าล่าสุด ${latest}`,
      labels: Array.from({ length: len }, (_, i) => String(i + 1)),
      series,
    };
  }
}

module.exports = { parseLine, SerialBuffer, MAX_LINES, MAX_SERIES };
