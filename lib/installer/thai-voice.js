'use strict';
// Installs the Windows Thai text-to-speech voice (Microsoft Pattara) as an
// optional Windows capability. Needs admin, so Windows shows a UAC prompt.

const { spawn } = require('child_process');

const CAPABILITY = 'Language.TextToSpeech~~~th-TH~0.0.1.0';

function installThaiVoice() {
  if (process.platform !== 'win32') return Promise.reject(new Error('รองรับเฉพาะ Windows'));
  // Fixed script — no user input is interpolated.
  const inner = `Add-WindowsCapability -Online -Name '${CAPABILITY}' | Out-Null`;
  const outer = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner}"; exit $p.ExitCode`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { shell: false, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(/canceled|ยกเลิก/i.test(err) ? 'ผู้ใช้ยกเลิกการขอสิทธิ์ admin' : `ติดตั้งไม่สำเร็จ (exit ${code}) ${err.slice(0, 300)}`));
    });
  });
}

module.exports = { installThaiVoice, CAPABILITY };
