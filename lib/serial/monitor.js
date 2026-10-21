'use strict';
// Live serial monitor for Arduino / ESP32 boards on COM ports. Reads through a PowerShell worker
// (System.IO.Ports) so no native module has to be built for Electron.
// The port name and baud rate are validated here and passed as separate arguments, never in a command string.

const { spawn, execFile } = require('child_process');
const path = require('path');
const { SerialBuffer } = require('./parse');

const PORT_RE = /^COM\d{1,3}$/;
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
const SCRIPT = path.join(__dirname, 'serial-worker.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** @returns {Promise<string[]>} e.g. ['COM3', 'COM4'] */
function listPorts() {
  return new Promise((resolve) => {
    execFile('powershell.exe', [...PS_ARGS, '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => PORT_RE.test(s)));
    });
  });
}

class SerialMonitor {
  /** @param {{onLine?: (line: string) => void, onState?: (s: {open: boolean, port: string, baud: number, error?: string}) => void, spawnFn?: Function}} o */
  constructor({ onLine, onState, spawnFn = spawn } = {}) {
    this.onLine = onLine || (() => {});
    this.onState = onState || (() => {});
    this.spawnFn = spawnFn;
    this.buffer = new SerialBuffer();
    this.proc = null;
    this.port = '';
    this.baud = 0;
  }

  get isOpen() {
    return !!this.proc;
  }

  /** @throws on an invalid port or baud rate, or when a port is already open */
  open(port, baud = 9600) {
    if (!PORT_RE.test(String(port))) throw new Error('ชื่อพอร์ตไม่ถูกต้อง (ต้องเป็น COM1–COM999)');
    if (!BAUDS.includes(baud)) throw new Error('baud rate ไม่รองรับ');
    if (this.proc) throw new Error(`เปิด ${this.port} อยู่แล้ว ปิดก่อนจึงจะเปิดพอร์ตใหม่`);
    this.buffer.clear();
    this.port = port;
    this.baud = baud;
    const proc = this.spawnFn('powershell.exe', [...PS_ARGS, '-File', SCRIPT, '-Port', port, '-Baud', String(baud)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = proc;
    let rest = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      rest += chunk;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const msg = rest.slice(0, i).replace(/\r$/, '');
        rest = rest.slice(i + 1);
        this._message(msg);
      }
    });
    proc.on('error', (e) => this._ended(proc, e.message));
    proc.on('exit', () => this._ended(proc));
  }

  _message(msg) {
    if (msg === 'R') this.onState({ open: true, port: this.port, baud: this.baud });
    else if (msg.startsWith('L:')) {
      const line = msg.slice(2);
      this.buffer.push(line);
      this.onLine(line);
    } else if (msg.startsWith('E:')) this.error = msg.slice(2);
  }

  _ended(proc, error) {
    if (this.proc !== proc) return; // an older process that was already replaced or closed
    this.proc = null;
    this.onState({ open: false, port: this.port, baud: this.baud, error: error || this.error });
    this.error = undefined;
  }

  close() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      if (process.platform === 'win32' && proc.pid) execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else proc.kill();
    } catch { /* already gone */ }
    this.onState({ open: false, port: this.port, baud: this.baud });
  }

  chart(n) {
    return this.buffer.toResult({ n, port: this.port });
  }
}

module.exports = { SerialMonitor, listPorts, PORT_RE, BAUDS };
