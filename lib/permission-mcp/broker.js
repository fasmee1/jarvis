'use strict';
// Main-process side of the permission system. Listens on a random named pipe;
// both the permission MCP server and the guard hook connect here. Each request
// is passed to `onRequest`, which returns a Promise of the decision. If nothing
// answers within the timeout the request is denied.

const net = require('net');
const crypto = require('crypto');

const MAX_REQ = 2 * 1024 * 1024;

function randomPipeName() {
  const id = crypto.randomBytes(12).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\jarvis-perm-${id}` : `/tmp/jarvis-perm-${id}.sock`;
}

class PermissionBroker {
  constructor({ onRequest, timeoutSec = 120, log = () => {} }) {
    this.onRequest = onRequest;
    this.timeoutSec = timeoutSec;
    this.log = log;
    this.pipe = randomPipeName();
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.seq = 0;
    this.idPrefix = crypto.randomBytes(4).toString('hex');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._conn(sock));
      this.server.on('error', reject);
      this.server.listen(this.pipe, () => resolve(this));
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  _conn(sock) {
    let buf = '';
    let handled = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      if (handled) return;
      buf += d;
      if (buf.length > MAX_REQ) {
        handled = true;
        sock.end(JSON.stringify({ behavior: 'deny', message: 'คำขอใหญ่เกินไป' }) + '\n');
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        sock.end(JSON.stringify({ behavior: 'deny', message: 'คำขออ่านไม่ได้' }) + '\n');
        return;
      }
      if (!req || req.token !== this.token) {
        sock.end(JSON.stringify({ behavior: 'deny', message: 'token ไม่ถูกต้อง' }) + '\n');
        return;
      }
      delete req.token;
      // the random part keeps ids unique across the brokers of several projects
      req.id = `perm-${this.idPrefix}-${Date.now()}-${++this.seq}`;
      const decision = await this._decide(req, sock);
      if (!sock.destroyed) sock.end(JSON.stringify(decision) + '\n');
    });
  }

  _decide(req, sock) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (d, why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(d);
        if (why && this.onSettled) this.onSettled(req, d, why);
      };
      const timer = setTimeout(
        () => settle({ behavior: 'deny', message: `ไม่มีการตอบภายใน ${this.timeoutSec} วินาที จึงปฏิเสธอัตโนมัติ` }, 'timeout'),
        this.timeoutSec * 1000
      );
      sock.on('close', () => settle({ behavior: 'deny', message: 'ยกเลิก' }, 'closed'));
      Promise.resolve()
        .then(() => this.onRequest(req))
        .then((d) => settle(normalizeDecision(d, req)), (err) => settle({ behavior: 'deny', message: 'ข้อผิดพลาด: ' + err.message }));
    });
  }
}

function normalizeDecision(d, req) {
  if (d && d.behavior === 'allow') return { behavior: 'allow', updatedInput: d.updatedInput || req.input || {} };
  return { behavior: 'deny', message: String((d && d.message) || 'ผู้ใช้ปฏิเสธ') };
}

module.exports = { PermissionBroker, randomPipeName, normalizeDecision };
