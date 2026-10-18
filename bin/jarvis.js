#!/usr/bin/env node
'use strict';
// `jarvis` command: launches the Mee JARVIS desktop app.
//   jarvis            open the app (last project folder)
//   jarvis .          open with the current folder as the project
//   jarvis <folder>   open with <folder> as the project

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
let electron;
try {
  electron = require(path.join(appRoot, 'node_modules', 'electron'));
} catch {
  console.error('ไม่พบ Electron — รัน "npm install" ในโฟลเดอร์ ' + appRoot + ' ก่อน');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const arg = process.argv[2];
if (arg === '-h' || arg === '--help') {
  console.log('ใช้งาน: jarvis [โฟลเดอร์โปรเจกต์]');
  process.exit(0);
}
if (arg) {
  const dir = path.resolve(arg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('ไม่พบโฟลเดอร์: ' + dir);
    process.exit(1);
  }
  env.JARVIS_START_CWD = dir;
}

const child = spawn(electron, [appRoot], { detached: true, stdio: 'ignore', env, shell: false, windowsHide: false });
child.unref();
console.log('เปิด Mee JARVIS แล้ว' + (env.JARVIS_START_CWD ? ` (โฟลเดอร์: ${env.JARVIS_START_CWD})` : ''));
