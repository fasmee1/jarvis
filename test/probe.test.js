'use strict';
// probeSlashCommands (lib/claude/probe.js): minimal-args throwaway CLI that reports "/" commands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeSlashCommands } = require('../lib/claude/probe');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-probe-'));
const argsFile = path.join(dir, 'args.json');
const script = (body) => {
  const f = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, body);
  return { command: process.execPath, prefixArgs: [f] };
};
const run = (cli, extra = {}) => probeSlashCommands({ resolveCommand: () => cli, cwd: dir, env: process.env, ...extra });

test('probe returns the slash commands from init and uses minimal args', async () => {
  const cli = script(`
require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({type:'system',subtype:'init',slash_commands:['cost','review']}) + '\\n');
  setTimeout(() => {}, 5000);
});`);
  const names = await run(cli).promise;
  assert.deepStrictEqual(names, ['cost', 'review']);
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!args.includes('--mcp-config') && !args.includes('--permission-prompt-tool') && !args.includes('--settings'));
});

test('probe resolves null when the CLI exits without init', async () => {
  const names = await run(script('process.stdin.once("data", () => process.exit(0));')).promise;
  assert.strictEqual(names, null);
});

test('probe resolves null on a missing binary', async () => {
  const names = await run({ command: path.join(dir, 'no-such-claude'), prefixArgs: [] }).promise;
  assert.strictEqual(names, null);
});

test('probe resolves null on timeout and on cancel', async () => {
  const hang = script('process.stdin.resume(); setTimeout(() => {}, 5000);');
  assert.strictEqual(await run(hang, { timeoutMs: 300 }).promise, null);
  const p = run(hang);
  p.cancel();
  assert.strictEqual(await p.promise, null);
});
