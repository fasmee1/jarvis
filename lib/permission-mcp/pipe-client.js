'use strict';
// Shared by the permission MCP server and the guard hook: send one request to
// the app's named pipe and wait for a single JSON line in reply.

const net = require('net');

function askBroker(request, { pipe, token, timeoutMs }) {
  return new Promise((resolve) => {
    if (!pipe || !token) {
      resolve({ behavior: 'deny', message: 'JARVIS: ไม่พบช่องทางขออนุญาต (pipe) — ปฏิเสธไว้ก่อน' });
      return;
    }
    let done = false;
    let buf = '';
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = net.connect(pipe);
    const timer = setTimeout(
      () => finish({ behavior: 'deny', message: 'JARVIS: หมดเวลารอการอนุญาต' }),
      timeoutMs
    );
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ ...request, token }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish({ behavior: 'deny', message: 'JARVIS: คำตอบจากแอปอ่านไม่ได้' });
      }
    });
    sock.on('error', (err) =>
      finish({ behavior: 'deny', message: 'JARVIS: เชื่อมต่อหน้าจออนุญาตไม่ได้ (' + err.code + ')' })
    );
    sock.on('close', () => finish({ behavior: 'deny', message: 'JARVIS: การเชื่อมต่อถูกปิดก่อนได้คำตอบ' }));
  });
}

module.exports = { askBroker };
