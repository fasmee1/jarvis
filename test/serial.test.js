'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { parseLine, SerialBuffer, MAX_SERIES } = require('../lib/serial/parse');
const { SerialMonitor, PORT_RE } = require('../lib/serial/monitor');

test('serial: numbers, labelled values and prose', () => {
  assert.deepEqual(parseLine('23.5'), [{ name: 's1', value: 23.5 }]);
  assert.deepEqual(parseLine('23.5,60,-1'), [{ name: 's1', value: 23.5 }, { name: 's2', value: 60 }, { name: 's3', value: -1 }]);
  assert.deepEqual(parseLine('temp:23.5 hum=60'), [{ name: 'temp', value: 23.5 }, { name: 'hum', value: 60 }]);
  assert.deepEqual(parseLine('Booting v2'), []);
  assert.deepEqual(parseLine(''), []);
  assert.equal(parseLine('1,2,3,4,5,6,7,8').length, MAX_SERIES);
});

test('serial: buffer keeps the newest samples and builds a chart', () => {
  const b = new SerialBuffer(5);
  for (let i = 1; i <= 8; i++) b.push(`t:${i}`);
  assert.equal(b.lines.length, 5);
  const r = b.toResult({ n: 3, port: 'COM3' });
  assert.equal(r.type, 'chart');
  assert.equal(r.title, 'Serial COM3');
  assert.deepEqual(r.series, [{ name: 't', values: [6, 7, 8] }]);
  assert.equal(r.labels.length, 3);
  assert.match(r.spokenSummary, /t 8/);
});

test('serial: no numbers falls back to the last text lines; empty says so', () => {
  const b = new SerialBuffer();
  assert.equal(b.toResult().type, 'text');
  assert.match(b.toResult().spokenSummary, /ยังไม่มีข้อมูล/);
  b.push('hello board');
  const r = b.toResult();
  assert.equal(r.type, 'text');
  assert.match(r.markdown, /hello board/);
});

test('serial: the monitor validates port and baud and never builds a command string', () => {
  assert.ok(PORT_RE.test('COM3'));
  assert.ok(!PORT_RE.test('COM3; calc'));
  assert.ok(!PORT_RE.test('/dev/ttyUSB0'));
  const m = new SerialMonitor({ spawnFn: () => { throw new Error('must not spawn'); } });
  assert.throws(() => m.open('COM3 & calc'), /ชื่อพอร์ต/);
  assert.throws(() => m.open('COM3', 12345), /baud/);
  assert.equal(m.isOpen, false);
});

test('serial: lines from the worker reach the buffer; exit reports closed; a second open is refused', () => {
  const calls = [];
  let proc;
  const spawnFn = (cmd, args) => {
    calls.push(args);
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.pid = 0;
    return proc;
  };
  const states = [];
  const lines = [];
  const m = new SerialMonitor({ spawnFn, onState: (s) => states.push(s), onLine: (l) => lines.push(l) });
  m.open('COM4', 115200);
  assert.deepEqual(calls[0].slice(-4), ['-Port', 'COM4', '-Baud', '115200']);
  assert.throws(() => m.open('COM3'), /เปิด COM4 อยู่แล้ว/);
  proc.stdout.emit('data', 'R\nL:t:1');
  proc.stdout.emit('data', '5\r\nL:t:16\n');
  assert.deepEqual(lines, ['t:15', 't:16']);
  assert.equal(states[0].open, true);
  assert.deepEqual(m.chart().series, [{ name: 't', values: [15, 16] }]);
  proc.stdout.emit('data', 'E:Access denied\n');
  proc.emit('exit');
  assert.equal(m.isOpen, false);
  assert.equal(states.at(-1).open, false);
  assert.equal(states.at(-1).error, 'Access denied');
});

test('serial: voice commands', async () => {
  const { parseCommand } = await import('../renderer/handsfree/commands.js');
  const op = (t) => parseCommand(t);
  assert.deepEqual(op('เปิดซีเรียล'), { action: 'serial', op: 'open' });
  assert.deepEqual(op('เปิดซีเรียล COM3'), { action: 'serial', op: 'open', port: 'COM3' });
  assert.deepEqual(op('เปิด serial port com4 baud 115200'), { action: 'serial', op: 'open', port: 'COM4', baud: 115200 });
  assert.deepEqual(op('ปิดซีเรียล'), { action: 'serial', op: 'close' });
  assert.deepEqual(op('ดูกราฟบอร์ด'), { action: 'serial', op: 'chart' });
  assert.deepEqual(op('ดูค่าจากเซนเซอร์'), { action: 'serial', op: 'chart' });
  assert.equal(op('ดูกราฟยอดขาย'), null);
});
