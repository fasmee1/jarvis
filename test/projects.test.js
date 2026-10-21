'use strict';
// Several projects at once (lib/projects.js): two background cores, each with its
// own fake "claude" process, folder, session and permission pipe, must not mix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore } = require('../lib/settings');
const { JarvisCore } = require('../lib/jarvis-core');
const { ProjectManager, projectIdFor } = require('../lib/projects');
const { v } = require('../lib/ipc-validate');

const tmp = (p = 'jarvis-proj-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Fake CLI: answers with its own cwd, pid and session id. "ask" asks the app's
// permission pipe first (like the permission MCP), "slow" takes 400 ms, "hang" never ends.
const PIPE_CLIENT = path.join(__dirname, '..', 'lib', 'permission-mcp', 'pipe-client.js');
const FAKE = `
const path=require('path');const {askBroker}=require(${JSON.stringify(PIPE_CLIENT)});
const sid='S-'+path.basename(process.cwd());
const o=e=>process.stdout.write(JSON.stringify(e)+'\\n');
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);turn(JSON.parse(l));}});
async function turn(m){
  const text=m.message.content.map(c=>c.text||'').join('');
  o({type:'system',subtype:'init',session_id:sid,mcp_servers:[{name:'jarvis',status:'connected'}],slash_commands:[]});
  if(text.includes('hang'))return;
  let extra='';
  if(text.includes('ask')){
    const d=await askBroker({kind:'permission',tool_name:'Bash',tool_use_id:'tu1',input:{command:'deploy-'+path.basename(process.cwd())}},{pipe:process.env.JARVIS_PIPE,token:process.env.JARVIS_TOKEN,timeoutMs:20000});
    extra=' decision='+d.behavior;
  }
  if(text.includes('plan')){
    const tu=(id,name,input)=>o({type:'assistant',message:{id:'m-'+id,content:[{type:'tool_use',id,name,input}]}});
    const tr=(id,err)=>o({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:err?'permission denied by user':'ok',is_error:!!err}]}});
    tu('t1','TodoWrite',{todos:[{content:'Read code',activeForm:'Reading code',status:'completed'},{content:'Fix bug',activeForm:'Fixing bug',status:'in_progress'},{content:'Run tests',activeForm:'Running tests',status:'pending'}]});
    tr('t1');
    tu('t2','Edit',{file_path:'a.js',old_string:'x',new_string:'y'});tr('t2');
    tu('t3','Edit',{file_path:'b.js',old_string:'x',new_string:'y'});tr('t3',true);
    tu('t4','Edit',{file_path:'a.js',old_string:'y',new_string:'z'});tr('t4');
  }
  if(text.includes('slow'))await new Promise(r=>setTimeout(r,400));
  const reply='cwd='+process.cwd()+' pid='+process.pid+extra;
  o({type:'assistant',message:{id:'m1',content:[{type:'text',text:reply}]}});
  o({type:'result',subtype:'success',is_error:false,session_id:sid,result:reply,permission_denials:[]});
}
`;

function setup({ max = 3 } = {}) {
  const work = tmp();
  const script = path.join(work, 'fake-claude.js');
  fs.writeFileSync(script, FAKE);
  const settings = new SettingsStore(tmp());
  settings.update({ autoApproveSafe: false, maxBackgroundProjects: max });
  const resolveCommand = () => ({ command: process.execPath, prefixArgs: [script] });
  const events = [];
  const ui = (channel, payload) => events.push([channel, payload]);
  const base = { settings, tempDir: tmp(), appRoot: tmp(), logDir: tmp(), resolveCommand };
  const main = new JarvisCore({ ...base, ui });
  const pm = new ProjectManager({
    main,
    settings,
    ui,
    home: tmp('jarvis-home-'), // os.tmpdir() is under AppData, which the attach rules refuse
    createCore: (o) => new JarvisCore({ ...base, ...o, primary: false }),
  });
  return { pm, main, settings, events, dirA: tmp('jarvis-A-'), dirB: tmp('jarvis-B-') };
}

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('timed out');
};
const statusOf = (events, id) => events.filter(([c, p]) => c === 'project:status' && p.projectId === id).map(([, p]) => p.status);
const lastStatus = (events, id) => statusOf(events, id).at(-1);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('two background projects run at once in their own folder, process and session', async (t) => {
  const { pm, main, events, dirA, dirB } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'slow A' });
  const b = await pm.start({ dir: dirB, text: 'slow B' });
  assert.notStrictEqual(a.projectId, b.projectId);
  assert.strictEqual(a.projectId, projectIdFor(dirA));
  assert.doesNotThrow(() => v.projectId(a.projectId));
  // both busy at the same time
  assert.ok(pm.get(a.projectId).session.busy && pm.get(b.projectId).session.busy);
  assert.strictEqual(pm.list().filter((x) => x.status === 'running').length, 2);
  await waitFor(() => lastStatus(events, a.projectId) === 'done' && lastStatus(events, b.projectId) === 'done');

  const ca = pm.get(a.projectId);
  const cb = pm.get(b.projectId);
  assert.strictEqual(ca.session.sessionId, 'S-' + path.basename(dirA));
  assert.strictEqual(cb.session.sessionId, 'S-' + path.basename(dirB));
  assert.notStrictEqual(ca.broker.pipe, cb.broker.pipe);
  assert.notStrictEqual(ca.broker.token, cb.broker.token);

  // every payload carries a project id, and each project only saw its own folder
  for (const [channel, p] of events) assert.ok(p && typeof p.projectId === 'string', `${channel} has projectId`);
  const texts = (id) => events.filter(([c, p]) => c === 'project:event' && p.projectId === id && p.channel === 'chat:item' && p.payload.type === 'text').map(([, p]) => p.payload.text).join('');
  assert.match(texts(a.projectId), new RegExp('cwd=' + dirA.replace(/\\/g, '\\\\')));
  assert.match(texts(b.projectId), new RegExp('cwd=' + dirB.replace(/\\/g, '\\\\')));
  assert.ok(!texts(a.projectId).includes(dirB) && !texts(b.projectId).includes(dirA));
  for (const [, p] of events.filter(([c]) => c === 'project:event')) assert.strictEqual(p.payload.projectId, p.projectId);

  // background events never land on the HUD's own channels or its voice
  assert.ok(!events.some(([c, p]) => (c === 'chat:item' || /^tts:/.test(c)) && p.projectId !== 'main'));
  assert.deepStrictEqual(statusOf(events, a.projectId), ['running', 'done']);
  assert.match(events.filter(([c, p]) => c === 'project:status' && p.projectId === a.projectId).at(-1)[1].announce, /เสร็จแล้ว/);
  // background cores don't change the HUD's folder
  assert.strictEqual(main.cwd, '');
});

test('approvals: each request belongs to one project and cannot be answered across projects', async (t) => {
  const { pm, main, events, dirA, dirB } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'ask A' });
  const b = await pm.start({ dir: dirB, text: 'ask B' });
  const reqs = await waitFor(() => {
    const r = events.filter(([c]) => c === 'approval:request').map(([, p]) => p);
    return r.length === 2 ? r : null;
  });
  const reqA = reqs.find((r) => r.projectId === a.projectId);
  const reqB = reqs.find((r) => r.projectId === b.projectId);
  assert.ok(reqA && reqB);
  assert.notStrictEqual(reqA.id, reqB.id);
  assert.strictEqual(reqA.projectName, path.basename(dirA));
  assert.strictEqual(reqA.input.command, 'deploy-' + path.basename(dirA));
  assert.strictEqual(lastStatus(events, a.projectId), 'awaiting-approval');

  // A's request answered as if it came from B (or from the HUD) is refused and stays open
  assert.strictEqual(pm.respondApproval(b.projectId, { id: reqA.id, decision: 'once' }).ok, false);
  assert.strictEqual(pm.respondApproval('main', { id: reqA.id, decision: 'once' }).ok, false);
  assert.strictEqual(pm.get(b.projectId).respondApproval({ id: reqB.id, projectId: a.projectId, decision: 'once' }).ok, false);
  assert.strictEqual(pm.get(a.projectId).pending.size, 1);

  assert.strictEqual(pm.respondApproval(a.projectId, { id: reqA.id, decision: 'once' }).ok, true);
  assert.strictEqual(pm.respondApproval(b.projectId, { id: reqB.id, decision: 'deny' }).ok, true);
  await waitFor(() => lastStatus(events, a.projectId) === 'done' && lastStatus(events, b.projectId) === 'done');
  assert.deepStrictEqual(statusOf(events, a.projectId), ['running', 'awaiting-approval', 'running', 'done']);
  const result = (id) => events.find(([c, p]) => c === 'project:event' && p.projectId === id && p.channel === 'turn:result')[1].payload.resultText;
  assert.match(result(a.projectId), /decision=allow/);
  assert.match(result(b.projectId), /decision=deny/);
});

test('stop one project, the other keeps going; one task per folder; folder rules', async (t) => {
  const { pm, main, settings, events, dirA, dirB } = setup({ max: 2 });
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'hang' });
  const b = await pm.start({ dir: dirB, text: 'slow' });

  // one task at a time per folder (the next one waits in the queue), and the running limit
  assert.strictEqual((await pm.start({ dir: dirA, text: 'again' })).queued, 1);
  assert.strictEqual(pm.list().find((x) => x.projectId === a.projectId).queue.length, 1);
  await assert.rejects(pm.start({ dir: tmp('jarvis-C-'), text: 'x' }), (e) => e.code === 'LIMIT');
  // folders that overlap a project are refused
  const nested = path.join(dirA, 'sub');
  fs.mkdirSync(nested);
  settings.update({ maxBackgroundProjects: 3 });
  await assert.rejects(pm.start({ dir: nested, text: 'x' }), (e) => e.code === 'FOLDER');

  await waitFor(() => pm.get(a.projectId).session && pm.get(a.projectId).session.proc);
  pm.stop(a.projectId);
  assert.strictEqual(lastStatus(events, a.projectId), 'stopped');
  assert.deepStrictEqual(pm.list().find((x) => x.projectId === a.projectId).queue, [], 'stopping clears the queue');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(lastStatus(events, a.projectId), 'stopped', 'the queued task did not start');
  await waitFor(() => lastStatus(events, b.projectId) === 'done');
  assert.ok(!statusOf(events, b.projectId).includes('stopped'));

  // the same folder reuses its core and resumes its conversation
  const before = pm.get(a.projectId);
  const again = await pm.start({ dir: dirA, text: 'ok' });
  assert.strictEqual(again.projectId, a.projectId);
  assert.strictEqual(pm.get(a.projectId), before);
  await waitFor(() => lastStatus(events, a.projectId) === 'done');

  // the HUD can't move into a folder a background task is busy in; idle projects make way
  const c = await pm.start({ dir: tmp('jarvis-C-'), text: 'hang' });
  assert.throws(() => main.setCwd(pm.get(c.projectId).cwd), (e) => e.code === 'FOLDER_IN_USE');
  main.setCwd(dirB);
  assert.strictEqual(main.cwd, path.resolve(dirB));
  assert.strictEqual(pm.get(b.projectId), null, 'idle project B was closed');
  // …and a background task can't use the HUD's folder
  await assert.rejects(pm.start({ dir: dirB, text: 'x' }), (e) => e.code === 'FOLDER');
});

test('stopping while waiting for approval: the request closes and a late result is not reported as a finished turn', async (t) => {
  const { pm, main, events, dirA } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'ask' });
  const req = await waitFor(() => events.find(([c, p]) => c === 'approval:request' && p.projectId === a.projectId));
  pm.stop(a.projectId);
  assert.strictEqual(lastStatus(events, a.projectId), 'stopped');
  assert.ok(events.some(([c, p]) => c === 'approval:close' && p.id === req[1].id));
  await new Promise((r) => setTimeout(r, 500)); // the denied CLI may still print its result
  assert.ok(!events.some(([c, p]) => c === 'project:event' && p.projectId === a.projectId && p.channel === 'turn:result'));
  assert.strictEqual(lastStatus(events, a.projectId), 'stopped');
});

test('background cores never run with bypassPermissions nor touch app-wide settings', async (t) => {
  const { pm, main, settings, dirA } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  assert.strictEqual(settings.setPermissionMode('bypassPermissions', 'ยืนยัน').ok, true);
  const before = settings.get().lastCwd;
  const a = await pm.start({ dir: dirA, text: 'quick' });
  const core = pm.get(a.projectId);
  const args = core.argsFor(null);
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'default');
  // opening it (setCwd → newSession) left the HUD's mode and folder alone
  assert.strictEqual(settings.get().permissionMode, 'bypassPermissions');
  assert.strictEqual(settings.get().lastCwd, before);
  assert.strictEqual(main.argsFor(null)[main.argsFor(null).indexOf('--permission-mode') + 1], 'bypassPermissions');
  settings.setPermissionMode('default');
});

test('progress: the plan (TodoWrite) and the files really changed are reported per project, and reset for a new task', async (t) => {
  const { pm, main, events, dirA, dirB } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'plan A' });
  const b = await pm.start({ dir: dirB, text: 'quick B' });
  await waitFor(() => lastStatus(events, a.projectId) === 'done' && lastStatus(events, b.projectId) === 'done');
  const pa = pm.list().find((x) => x.projectId === a.projectId);
  assert.deepStrictEqual(pa.progress, { done: 1, total: 3, current: 'Fixing bug' });
  assert.strictEqual(pa.filesChanged, 1, 'a.js counted once; the denied edit of b.js not at all');
  assert.deepStrictEqual(pa.todos.map((x) => x.status), ['completed', 'in_progress', 'pending']);
  // another project never sees them
  const pb = pm.list().find((x) => x.projectId === b.projectId);
  assert.deepStrictEqual(pb.progress, { done: 0, total: 0, current: '' });
  assert.strictEqual(pb.filesChanged, 0);
  // progress reaches the UI as a status update while the task runs
  assert.ok(events.some(([c, p]) => c === 'project:status' && p.projectId === a.projectId && p.status === 'running' && p.progress.total === 3));
  // a follow-up task in the same project starts from a clean plan
  await pm.start({ dir: dirA, text: 'quick' });
  const again = pm.list().find((x) => x.projectId === a.projectId);
  assert.deepStrictEqual(again.progress, { done: 0, total: 0, current: '' });
  assert.strictEqual(again.filesChanged, 0);
});

test('queue: tasks sent while one runs wait and follow in order; they can be removed; the queue is capped; stop clears it', async (t) => {
  const { pm, main, events, dirA } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'slow one' });
  const q1 = await pm.start({ dir: dirA, text: 'two' });
  await pm.start({ dir: dirA, text: 'removed' });
  await pm.start({ dir: dirA, text: 'three' });
  assert.strictEqual(q1.queued, 1);
  assert.deepStrictEqual(pm.list()[0].queue, ['two', 'removed', 'three']);
  assert.strictEqual(pm.dequeue(a.projectId, 1).ok, true);
  assert.strictEqual(pm.dequeue(a.projectId, 5).ok, false);
  const sentOf = () => events.filter(([c, p]) => c === 'project:event' && p.channel === 'user:message').map(([, p]) => p.payload.text);
  await waitFor(() => sentOf().length === 3 && lastStatus(events, a.projectId) === 'done' && pm.list()[0].queue.length === 0);
  assert.deepStrictEqual(sentOf(), ['slow one', 'two', 'three']);
  // "done" was announced with what follows while the queue was not empty
  assert.ok(events.some(([c, p]) => c === 'project:status' && p.announce && /เหลือในคิว 1 งาน/.test(p.announce)));
  // a queue is capped
  const b = await pm.start({ dir: dirA, text: 'hang' });
  for (let i = 0; i < 10; i++) await pm.start({ dir: dirA, text: 'w' + i });
  await assert.rejects(pm.start({ dir: dirA, text: 'one too many' }), (e) => e.code === 'LIMIT');
  pm.stop(b.projectId);
});

test('restart: projects come back idle with their session; the next task resumes the conversation; a task cut off shows as stopped', async (t) => {
  const stateFile = path.join(tmp(), 'projects.json');
  const one = setup();
  one.pm.stateFile = stateFile;
  await one.main.init();
  const a = await one.pm.start({ dir: one.dirA, text: 'quick A' });
  const b = await one.pm.start({ dir: one.dirB, text: 'hang B' });
  await one.pm.start({ dir: one.dirB, text: 'waiting' });
  await waitFor(() => lastStatus(one.events, a.projectId) === 'done');
  one.pm.disposeAll(); // app exit: writes the file while the entries still exist
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(saved.projects.length, 2);

  const two = setup();
  two.pm.stateFile = stateFile;
  t.after(() => two.pm.disposeAll());
  await two.main.init();
  assert.strictEqual(two.pm.restore(), 2);
  const list = two.pm.list();
  const ra = list.find((x) => x.projectId === a.projectId);
  const rb = list.find((x) => x.projectId === b.projectId);
  assert.strictEqual(ra.status, 'done');
  assert.strictEqual(rb.status, 'stopped');
  assert.match(rb.error, /แอปปิดระหว่างทำงาน \(คิวที่ค้าง 1 งานถูกล้าง\)/);
  assert.deepStrictEqual(rb.queue, []);
  assert.strictEqual(two.pm.get(a.projectId), null, 'no process until a task comes');
  // the next task opens the core and continues the saved conversation
  await two.pm.start({ dir: one.dirA, text: 'again A' });
  assert.strictEqual(two.pm.get(a.projectId).resumeId, 'S-' + path.basename(one.dirA));
  await waitFor(() => lastStatus(two.events, a.projectId) === 'done');
});

test('restore ignores damaged or hostile state files', () => {
  const { pm, dirA } = setup();
  const file = path.join(tmp(), 'projects.json');
  pm.stateFile = file;
  assert.strictEqual(pm.restore(), 0); // no file
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(pm.restore(), 0);
  fs.writeFileSync(file, JSON.stringify({ projects: [null, { cwd: 'relative/dir' }, { cwd: path.join(dirA, 'missing') }, { cwd: dirA, sessionId: '--bad id; rm', status: 'bogus' }] }));
  assert.strictEqual(pm.restore(), 1);
  const e = pm.list()[0];
  assert.strictEqual(e.status, 'idle');
  assert.strictEqual(pm.projects.get(e.projectId).sessionId, null, 'a session id that is not a plain id is dropped');
});

// ---- git worktrees and taking a project over in the HUD ----
const { execFileSync } = require('child_process');
const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function makeRepo() {
  const repo = path.join(tmp('jarvis-wt-'), 'repo');
  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('isolate: the task works in its own worktree and branch, so the HUD can sit in the original folder', async (t) => {
  const { pm, main, events } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const repo = makeRepo();
  main.setCwd(repo); // the HUD works in the repo itself
  await assert.rejects(pm.start({ dir: repo, text: 'quick' }), (e) => e.code === 'FOLDER', 'without isolation the HUD folder is refused');

  const a = await pm.start({ dir: repo, text: 'quick A', isolate: true });
  const b = await pm.start({ dir: repo, text: 'quick B', isolate: true });
  assert.notStrictEqual(a.projectId, b.projectId, 'two isolated tasks on one repo');
  await waitFor(() => lastStatus(events, a.projectId) === 'done' && lastStatus(events, b.projectId) === 'done');
  const pa = pm.list().find((x) => x.projectId === a.projectId);
  assert.match(pa.branch, /^jarvis\/t-/);
  assert.strictEqual(pa.origin, repo);
  assert.ok(pa.cwd.startsWith(repo + '.jarvis-wt'), pa.cwd);
  assert.ok(fs.existsSync(path.join(pa.cwd, 'a.txt')), 'a full checkout');
  assert.match(gitIn(repo, 'branch', '--list', 'jarvis/*'), /jarvis\/t-/);
  // the Claude process ran in the copy
  const text = events.filter(([c, p]) => c === 'project:event' && p.projectId === a.projectId && p.channel === 'chat:item' && p.payload.type === 'text').map(([, p]) => p.payload.text).join('');
  assert.ok(text.includes('cwd=' + pa.cwd), text);
  // a follow-up (no isolate flag) continues in the same copy
  const again = await pm.start({ dir: pa.cwd, text: 'quick again' });
  assert.strictEqual(again.projectId, a.projectId);
  await waitFor(() => lastStatus(events, a.projectId) === 'done');

  // not a git repo / not the repo root
  await assert.rejects(pm.start({ dir: tmp('jarvis-plain-'), text: 'x', isolate: true }), (e) => e.code === 'NOT_GIT');
  fs.mkdirSync(path.join(repo, 'sub'));
  await assert.rejects(pm.start({ dir: path.join(repo, 'sub'), text: 'x', isolate: true }), (e) => e.code === 'NOT_GIT');
});

test('closing an isolated project removes an untouched copy and keeps one with work in it', async (t) => {
  const { pm, main, events } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const repo = makeRepo();
  const a = await pm.start({ dir: repo, text: 'quick A', isolate: true });
  const b = await pm.start({ dir: repo, text: 'quick B', isolate: true });
  await waitFor(() => lastStatus(events, a.projectId) === 'done' && lastStatus(events, b.projectId) === 'done');
  const dirA = pm.list().find((x) => x.projectId === a.projectId).cwd;
  const dirB = pm.list().find((x) => x.projectId === b.projectId).cwd;
  fs.writeFileSync(path.join(dirB, 'work.txt'), 'unsaved work'); // B has an uncommitted change

  pm.remove(a.projectId);
  pm.remove(b.projectId);
  await waitFor(() => !fs.existsSync(dirA));
  await waitFor(() => events.some(([c, p]) => c === 'project:status' && p.status === 'removed' && p.announce && p.announce.includes(dirB)));
  assert.ok(fs.existsSync(path.join(dirB, 'work.txt')), 'work in a copy is never deleted');
  const branches = () => gitIn(repo, 'branch', '--list', 'jarvis/*').split('\n').filter(Boolean); // A's is deleted just after its folder
  await waitFor(() => branches().length === 1);
  assert.match(branches()[0], new RegExp(path.basename(dirB).replace(/^t-/, 't-')));
});

test('promote: an idle project moves to the HUD with its folder and session; a busy one cannot', async (t) => {
  const { pm, main, events, dirA, dirB } = setup();
  t.after(() => pm.disposeAll());
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'hang' });
  assert.strictEqual(pm.promote(a.projectId).ok, false, 'busy');
  pm.stop(a.projectId);
  const b = await pm.start({ dir: dirB, text: 'quick B' });
  await waitFor(() => lastStatus(events, b.projectId) === 'done');
  assert.strictEqual(pm.promote('p-0000000000').ok, false);
  const r = pm.promote(b.projectId);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(main.cwd, path.resolve(dirB));
  assert.strictEqual(main.resumeId, 'S-' + path.basename(dirB));
  assert.strictEqual(pm.get(b.projectId), null, 'it left the background list');
  // a project without a conversation yet has nothing to take over
  pm.projects.get(a.projectId).sessionId = null;
  assert.strictEqual(pm.promote(a.projectId).ok, false);
});

test('restored worktree entries are only trusted inside their copy folder', () => {
  const { pm, dirA } = setup();
  const repo = makeRepo();
  const inside1 = path.join(repo + '.jarvis-wt', 't-abc');
  fs.mkdirSync(inside1, { recursive: true });
  const sha = 'a'.repeat(40);
  const file = path.join(tmp(), 'projects.json');
  pm.stateFile = file;
  fs.writeFileSync(file, JSON.stringify({ projects: [
    { cwd: inside1, origin: repo, branch: 'jarvis/t-abc', baseSha: sha },
    { cwd: dirA, origin: repo, branch: 'jarvis/t-abc', baseSha: sha }, // not under the copy folder
  ] }));
  assert.strictEqual(pm.restore(), 2);
  const byCwd = (c) => pm.list().find((x) => x.cwd === c);
  assert.strictEqual(byCwd(inside1).branch, 'jarvis/t-abc');
  assert.strictEqual(byCwd(path.resolve(dirA)).branch, null, 'treated as a plain folder: never cleaned up');
});

test('disposeAll kills every project process tree', async () => {
  const { pm, main, dirA, dirB } = setup();
  await main.init();
  const a = await pm.start({ dir: dirA, text: 'hang' });
  const b = await pm.start({ dir: dirB, text: 'hang' });
  const pids = await waitFor(() => {
    const p = [a, b].map((x) => pm.get(x.projectId).session.proc && pm.get(x.projectId).session.proc.pid);
    return p.every(Boolean) ? p : null;
  });
  assert.ok(pids.every(alive));
  pm.disposeAll();
  await waitFor(() => !pids.some(alive));
  assert.deepStrictEqual(pm.list(), []);
});
