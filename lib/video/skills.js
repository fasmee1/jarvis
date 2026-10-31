'use strict';
// Editing skills: a SKILL.md the user uploads tells JARVIS how to edit (pace, story, captions,
// graphics, sound). The text is only instructions for Claude: nothing in it is run.
//   parseSkill(text, fallbackName)  pure: frontmatter + body → { name, description, prompt, pace, targetSec }
//   readSkill(file)                 reads SKILL.md and, next to it, references/*.md|*.txt (text only, size-capped)

const fs = require('fs');
const path = require('path');

const MAX_SKILL = 60000; // characters of instructions, references included
const MAX_FILE = 200 * 1024; // bytes of one file
const MAX_REFS = 20;
const SKILL_EXT = /\.(md|markdown|txt)$/i;

class SkillError extends Error {}

const PACE_WORDS = { fast: 'fast', normal: 'normal', slow: 'slow', เร็ว: 'fast', ปานกลาง: 'normal', ช้า: 'slow' };

/** "key: value" lines between --- fences; quotes around a value are dropped. */
function frontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Plain text only: no NUL or other control bytes apart from tab and newline. */
function checkText(text, what) {
  if (typeof text !== 'string') throw new SkillError(`${what} ไม่ใช่ไฟล์ข้อความ`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new SkillError(`${what} ไม่ใช่ไฟล์ข้อความ (มีอักขระควบคุม)`);
}

function parseSkill(raw, fallbackName = '') {
  checkText(raw, 'ไฟล์สกิล');
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { meta, body } = frontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(body);
  const name = String(meta.name || (heading && heading[1]) || fallbackName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) throw new SkillError('สกิลต้องมีชื่อ (ใส่ name: ในส่วนหัวของไฟล์)');
  const prompt = body.trim();
  if (!prompt) throw new SkillError('สกิลนี้ไม่มีเนื้อหาคำแนะนำ');
  const pace = PACE_WORDS[String(meta.pace || '').toLowerCase()] || 'normal';
  const t = Number(meta.target || meta['target-sec'] || meta.targetsec || 0);
  const targetSec = Number.isInteger(t) && t >= 0 && t <= 600 ? t : 0;
  return { name, description: String(meta.description || '').replace(/\s+/g, ' ').trim().slice(0, 300), prompt, pace, targetSec };
}

function readText(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new SkillError(`${path.basename(file)} ไม่ใช่ไฟล์`);
  if (st.size > MAX_FILE) throw new SkillError(`${path.basename(file)} ใหญ่เกินไป (ไม่เกิน ${MAX_FILE / 1024} KB)`);
  const text = fs.readFileSync(file, 'utf8');
  checkText(text, path.basename(file));
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Reads a skill the user picked: a .md file (usually SKILL.md). Text files in a "references"
 * folder next to it are added after the instructions. Symlinks and other files are skipped.
 */
function readSkill(file) {
  if (!path.isAbsolute(file) || !SKILL_EXT.test(file)) throw new SkillError('เลือกไฟล์สกิล .md');
  const skill = parseSkill(readText(file), path.basename(path.dirname(file)));
  const refDir = path.join(path.dirname(file), 'references');
  const refs = [];
  try {
    if (fs.lstatSync(refDir).isDirectory()) {
      for (const n of fs.readdirSync(refDir).filter((x) => SKILL_EXT.test(x)).sort().slice(0, MAX_REFS)) {
        const f = path.join(refDir, n);
        if (fs.lstatSync(f).isFile()) refs.push(`\n\n---\n## เอกสารอ้างอิง: ${n}\n\n${readText(f).trim()}`);
      }
    }
  } catch (err) {
    if (err instanceof SkillError) throw err;
  }
  skill.prompt += refs.join('');
  if (skill.prompt.length > MAX_SKILL) throw new SkillError(`สกิลยาวเกินไป (รวมเอกสารอ้างอิงไม่เกิน ${MAX_SKILL.toLocaleString()} ตัวอักษร)`);
  skill.refs = refs.length;
  return skill;
}

const NO_ZOOM = /ห้าม\s*(?:เพิ่ม\s*)?(?:zoom|ซูม)|ไม่\s*(?:ต้อง\s*)?(?:เพิ่ม\s*)?(?:zoom|ซูม)|\bno[\s-]+zoom\b|\bdo(?:\s+not|n't)\s+(?:add\s+)?zoom/i;
const LOCAL_SOUND = /Downloads[\\/]([A-Za-z0-9][\w.\- ()]{0,80}?)(?=[`'"”’)\]\s,;:]|$)/g;

/**
 * The hard rules a skill states in plain words, which the app can keep itself:
 *   noZoom        the skill forbids zoom → no zoom effects on the picture
 *   localSounds   names after "Downloads/…" the skill wants played (looked up in the Downloads folder only)
 */
function skillRules(prompt) {
  const text = String(prompt || '');
  const names = [];
  for (const m of text.matchAll(LOCAL_SOUND)) {
    const n = m[1].trim().replace(/[.\-]+$/, '');
    if (n && !names.includes(n)) names.push(n);
  }
  return { noZoom: NO_ZOOM.test(text), localSounds: names.slice(0, 3) };
}

module.exports = { parseSkill, readSkill, skillRules, SkillError, MAX_SKILL };
