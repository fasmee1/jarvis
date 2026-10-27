'use strict';
// The editor's state in the main process: imported clips, the one edit list, the
// analysis jobs (one at a time, queued) and the style cut (JARVIS edits by a style,
// in the background). The renderer only ever sees snapshots (no disk paths) and
// changes things through IPC that calls these methods.

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./edit-list');
const crypto = require('crypto');
const captions = require('./captions');
const hfp = require('./hf-project');
const { assetName } = require('./hf-render');
const exportPresets = require('./export-presets');
const effects = require('./effects');
const { buildPieces, buildPlanPrompt, parsePlan, basicPlan, SYSTEM } = require('./planner');

const NOTE_MAX = 1000;
const RENDER_LABELS = {
  compile: 'เตรียมโปรเจกต์', extract_video: 'ดึงภาพจากคลิป', process_audio: 'จัดการเสียง',
  start_browsers: 'เปิดตัววาดภาพ', capture: 'วาดภาพและซับทีละเฟรม', encode: 'รวมเป็นวิดีโอ',
};

class VideoService {
  /**
   * registry: MediaRegistry · ffmpeg: Ffmpeg · analyzer: ClipAnalyzer · styles: StyleStore
   * ask({ prompt, system, signal }) → Claude's answer text (lib/video/ask-claude.js)
   * hf: HfRender (lib/video/hf-render.js) — builds the video with subtitles and effects.
   * emit(channel, payload): 'video:state' snapshots, 'video:progress' analysis updates,
   * 'video:cut' style-cut updates, 'video:render' video-building updates.
   */
  constructor({ registry, ffmpeg, analyzer, styles, ask, hf = null, sfxDir = path.join(os.tmpdir(), 'mee-jarvis-sfx'), emit = () => {}, now = () => Date.now() }) {
    this.registry = registry;
    this.ffmpeg = ffmpeg;
    this.analyzer = analyzer;
    this.styles = styles;
    this.ask = ask;
    this.hf = hf;
    this.sfxDir = sfxDir;
    this.projectId = `p${crypto.randomBytes(4).toString('hex')}`;
    this.renderNo = 0;
    this.render = null; // { ac, fraction, label, startedAt }
    this.lastRender = null;
    this.lastExport = null; // path of the last saved file
    this.emit = emit;
    this.now = now;
    this.fix = null; // { ac, sourceId }: JARVIS is checking the words of one clip
    this.cut = null; // { ac, stage, label, overall, startedAt, styleName }
    this.lastCut = null; // result of the last finished cut (shown until the next one)
    this.idleWaiters = [];
    this.reset();
  }

  reset() {
    if (this.job) this.job.ac.abort();
    if (this.cut) this.cut.ac.abort();
    if (this.fix) this.fix.ac.abort();
    if (this.render) this.render.ac.abort();
    this.lastRender = null;
    this.lastCut = null;
    this.sources = new Map(); // id → { id, path, name, url, kind, duration, video, audio, analysis, analyzeError }
    this.nextSource = 1;
    this.history = new E.EditHistory(E.emptyList());
    this.queue = [];
    this.job = null; // { sourceId, ac, stage, label, overall, startedAt }
  }

  /** Imports files the user picked or dropped. Resolves { added: [ids], rejected: [{ name, reason }] }. */
  async importFiles(paths) {
    const added = [];
    const rejected = [];
    for (const p of paths) {
      const name = path.basename(String(p || '')) || String(p);
      try {
        const media = this.registry.add(p);
        const known = [...this.sources.values()].find((s) => s.path === media.path);
        if (known) {
          rejected.push({ name, reason: 'นำเข้าไว้แล้ว' });
          continue;
        }
        const info = await this.ffmpeg.probe(media.path);
        if (!info.duration) throw new Error('อ่านความยาวคลิปไม่ได้');
        const id = `s${this.nextSource++}`;
        this.sources.set(id, {
          id, path: media.path, name: media.name, url: media.url, kind: media.kind,
          duration: info.duration, video: info.video, audio: info.audio, analysis: null, analyzeError: '',
        });
        let list = this.history.list;
        list = { ...list, sources: [...list.sources, { id, path: media.path, duration: info.duration }] };
        this.history.apply(() => E.addClip(list, { src: id, in: 0, out: info.duration }));
        added.push(id);
        this.queue.push(id);
      } catch (err) {
        rejected.push({ name, reason: err.message });
      }
    }
    this._changed();
    this._next();
    return { added, rejected };
  }

  /** Re-runs the analysis of one clip (e.g. after installing whisper). */
  analyze(sourceId) {
    if (!this.sources.has(sourceId)) throw new Error('ไม่พบคลิปนี้');
    if ((this.job && this.job.sourceId === sourceId) || this.queue.includes(sourceId)) return { queued: true };
    this.queue.push(sourceId);
    this._next();
    return { queued: true };
  }

  /** Stops the running analysis and drops the queue. */
  cancel() {
    this.queue = [];
    if (this.job) this.job.ac.abort();
    this._changed();
    return { ok: true };
  }

  async _next() {
    if (this.job || !this.queue.length) return;
    const sourceId = this.queue.shift();
    const src = this.sources.get(sourceId);
    if (!src) return this._next();
    const ac = new AbortController();
    this.job = { sourceId, ac, stage: 'probe', label: 'อ่านข้อมูลคลิป', overall: 0, startedAt: Date.now() };
    src.analyzeError = '';
    this._progress();
    try {
      src.analysis = await this.analyzer.analyze(src.path, {
        signal: ac.signal,
        onProgress: (p) => {
          if (this.job && this.job.ac === ac) {
            Object.assign(this.job, { stage: p.stage, label: p.label, overall: p.overall });
            this._progress();
          }
        },
      });
    } catch (err) {
      src.analyzeError = err.code === 'ABORTED' ? 'ยกเลิกแล้ว' : err.message;
    } finally {
      if (this.job && this.job.ac === ac) this.job = null;
      if (this.sources.get(sourceId) === src) this._changed();
      this._progress();
      this._next();
      if (!this.job && !this.queue.length) this.idleWaiters.splice(0).forEach((fn) => fn());
    }
  }

  /** Resolves when no clip is being analysed or waiting to be. */
  _analysisIdle() {
    if (!this.job && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** One timeline edit (see edit-list applyOp). Returns the new snapshot; a bad edit throws and changes nothing. */
  edit(op) {
    if (this.cut) throw new Error('รอให้ JARVIS ตัดต่อเสร็จก่อน');
    try {
      this.history.apply(E.applyOp, op);
    } catch (err) {
      if (err instanceof E.EditError) throw new Error(err.message);
      throw err;
    }
    this._changed();
    return this.snapshot();
  }

  // ---------- transcript words ----------

  _segments(sourceId) {
    const src = this.sources.get(sourceId);
    const t = src && src.analysis && src.analysis.transcript;
    if (!t) throw new Error('ยังไม่มีคำพูดที่ถอดได้ในคลิปนี้');
    return t.segments;
  }

  _setCaption(seg, text) {
    if (seg.orig === undefined) seg.orig = seg.text;
    seg.text = text;
    if (text === seg.orig) { delete seg.orig; delete seg.edited; } else seg.edited = true;
  }

  /** The user fixes the words of one line by hand. */
  editCaption({ sourceId, i, text }) {
    const seg = this._segments(sourceId)[i];
    if (!seg) throw new Error('ไม่พบประโยคนี้');
    try {
      this._setCaption(seg, captions.cleanText(text));
    } catch (err) {
      if (err instanceof captions.CaptionError) throw new Error(err.message);
      throw err;
    }
    this._changed();
    return this.snapshot();
  }

  /**
   * Moves the start and end of one subtitle line (source seconds). The line must stay inside
   * the clip, be at least 0.2 s long and not run into the lines on either side.
   */
  setCaptionTime({ sourceId, i, start, end }) {
    const segs = this._segments(sourceId);
    const seg = segs[i];
    if (!seg) throw new Error('ไม่พบประโยคนี้');
    if (![start, end].every(Number.isFinite)) throw new Error('เวลาซับไม่ถูกต้อง');
    const duration = this.sources.get(sourceId).duration;
    if (start < 0 || end > duration + 1e-6 || end - start < 0.2) throw new Error('เวลาซับไม่ถูกต้อง (ต้องอยู่ในคลิปและยาวอย่างน้อย 0.2 วินาที)');
    if (segs[i - 1] && start < segs[i - 1].end - 1e-6) throw new Error('ซับทับกับประโยคก่อนหน้า');
    if (segs[i + 1] && end > segs[i + 1].start + 1e-6) throw new Error('ซับทับกับประโยคถัดไป');
    seg.start = Math.round(start * 1000) / 1000;
    seg.end = Math.round(end * 1000) / 1000;
    this._changed();
    return this.snapshot();
  }

  /** Puts a line back to what the transcriber heard. */
  restoreCaption({ sourceId, i }) {
    const seg = this._segments(sourceId)[i];
    if (!seg) throw new Error('ไม่พบประโยคนี้');
    if (seg.orig !== undefined) this._setCaption(seg, seg.orig);
    this._changed();
    return this.snapshot();
  }

  /**
   * JARVIS (a separate Claude run) fixes mis-heard words, mostly English terms written as Thai.
   * Lines the user already fixed by hand are left alone. Resolves { changed, total }.
   */
  async fixCaptions({ sourceId, hint = '' }) {
    if (this.fix) throw new Error('JARVIS กำลังตรวจคำอยู่');
    const segs = this._segments(sourceId);
    if (!segs.length) throw new Error('ยังไม่มีคำพูดที่ถอดได้ในคลิปนี้');
    const ac = new AbortController();
    this.fix = { ac, sourceId };
    this._changed();
    try {
      const stop = new Promise((resolve, reject) => ac.signal.addEventListener('abort', () => reject(new Error('ยกเลิกแล้ว')), { once: true }));
      const answer = await Promise.race([this.ask({ prompt: captions.buildFixPrompt(segs, hint), system: captions.SYSTEM, signal: ac.signal }), stop]);
      let changed = 0;
      for (const f of captions.parseFixes(answer, segs)) {
        if (segs[f.i].edited) continue;
        this._setCaption(segs[f.i], f.text);
        changed++;
      }
      return { changed, total: Math.min(segs.length, captions.MAX_LINES) };
    } catch (err) {
      if (err instanceof captions.CaptionError) throw new Error(err.message);
      throw err;
    } finally {
      this.fix = null;
      this._changed();
    }
  }

  // ---------- video with subtitles (HyperFrames) ----------

  /** Subtitle lines on the timeline (cut, retimed, split into short lines) — what the render shows. */
  _captionLines(list, segs) {
    return hfp.mapCaptions(list.clips, segs).flatMap((c) => hfp.splitLines(c));
  }

  /** The page HyperFrames renders, from the edit list and the transcript lines (as the user fixed them). */
  _projectSpec(captionStyle, { canvas = null, fit = 'cover' } = {}) {
    const list = this.history.list;
    const used = [...new Set(list.clips.map((c) => c.src))].map((id) => this.sources.get(id)).filter(Boolean);
    const sources = {};
    const segs = {};
    for (const s of used) {
      sources[s.id] = { file: `assets/${assetName(s.id, s.path)}`, kind: s.kind === 'audio' ? 'audio' : 'video', audio: !!s.audio };
      const t = s.analysis && s.analysis.transcript;
      segs[s.id] = t ? t.segments.map((g) => ({ start: g.start, end: g.end, text: g.text })) : [];
    }
    const lines = this._captionLines(list, segs);
    const spec = { clips: list.clips, overlays: list.overlays || [], sources, captions: lines, canvas: canvas || hfp.canvasFor(used), captionStyle, fit };
    return { spec, used, lines: lines.length };
  }

  /**
   * Builds the video (edit list + subtitles) in the background. Returns at once; progress and the
   * result arrive as 'video:render' events. The result's url plays in the editor (a new file each time).
   */
  startRender({ captionStyle = 'classic', quality = 'draft' } = {}) {
    if (!this.hf) throw new Error('ยังสร้างวิดีโอไม่ได้ในตอนนี้');
    if (this.render) throw new Error('กำลังสร้างวิดีโออยู่ — รอให้เสร็จหรือกดยกเลิกก่อน');
    if (this.cut) throw new Error('รอให้ JARVIS ตัดต่อเสร็จก่อน');
    if (!this.history.list.clips.length) throw new Error('ยังไม่มีคลิปในแถบเวลา — นำเข้าคลิปก่อน');
    const { spec, used, lines } = this._projectSpec(captionStyle);
    const ac = new AbortController();
    const job = { ac, fraction: 0, label: 'เตรียมโปรเจกต์', startedAt: this.now(), kind: 'preview' };
    this.render = job;
    this.lastRender = null;
    this._renderProgress();
    this._runRender(job, { spec, duration: E.totalLength(this.history.list), files: used.map((s) => ({ id: s.id, path: s.path })), quality, lines });
    return { started: true, captions: lines };
  }

  /**
   * Builds the finished video for a place (TikTok, Reels, Shorts…) and saves it to `target`
   * (an absolute .mp4 path the user picked in the save dialog). Same job slot as the preview.
   */
  startExport({ captionStyle = 'classic', preset: presetId, fit = 'cover', target }) {
    if (!this.hf) throw new Error('ยังสร้างวิดีโอไม่ได้ในตอนนี้');
    const p = exportPresets.preset(presetId);
    if (!exportPresets.FITS[fit]) throw new Error('แบบการจัดภาพไม่ถูกต้อง');
    if (this.render) throw new Error('กำลังสร้างวิดีโออยู่ — รอให้เสร็จหรือกดยกเลิกก่อน');
    if (this.cut) throw new Error('รอให้ JARVIS ตัดต่อเสร็จก่อน');
    if (!this.history.list.clips.length) throw new Error('ยังไม่มีคลิปในแถบเวลา — นำเข้าคลิปก่อน');
    if (typeof target !== 'string' || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.mp4') throw new Error('ไฟล์ปลายทางต้องเป็น .mp4 และระบุที่อยู่เต็ม');
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    if ([...this.sources.values()].some((s) => same(s.path, target))) throw new Error('ห้ามบันทึกทับไฟล์ต้นฉบับ — เลือกชื่อไฟล์ใหม่');
    if (!fs.existsSync(path.dirname(target))) throw new Error('ไม่พบโฟลเดอร์ปลายทาง');
    const { spec, used, lines } = this._projectSpec(captionStyle, { canvas: { width: p.width, height: p.height }, fit });
    const duration = E.totalLength(this.history.list);
    const ac = new AbortController();
    const job = { ac, fraction: 0, label: 'เตรียมโปรเจกต์', startedAt: this.now(), kind: 'export' };
    this.render = job;
    this.lastRender = null;
    this._renderProgress();
    this._runRender(job, { spec, duration, files: used.map((s) => ({ id: s.id, path: s.path })), quality: 'standard', fps: p.fps, lines, target });
    return { started: true, preset: p.id, note: exportPresets.lengthNote(p, duration) };
  }

  /** Where the last export went (for "open folder"); null when none. */
  lastExportPath() {
    return this.lastExport && fs.existsSync(this.lastExport) ? this.lastExport : null;
  }

  cancelRender() {
    if (this.render) this.render.ac.abort();
    return { ok: true };
  }

  /**
   * The sounds the clips ask for, made once by ffmpeg and kept in sfxDir.
   * Resolves { files: { whoosh: <path> }, missing: ['ding'] } — a sound that cannot be made is left out.
   */
  async _ensureSfx(clips, signal) {
    const want = [...new Set(clips.map((c) => c.sfx).filter((id) => id && id !== 'none' && effects.isSfx(id)))];
    const files = {};
    const missing = [];
    for (const id of want) {
      const file = path.join(this.sfxDir, `${id}.wav`);
      if (!fs.existsSync(file)) {
        try {
          fs.mkdirSync(this.sfxDir, { recursive: true });
          const { ffmpeg } = await this.ffmpeg.require();
          const tmp = `${file}.part.wav`;
          const r = await this.ffmpeg.run(ffmpeg, effects.sfxArgs(id, tmp), { signal });
          if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error('ffmpeg');
          fs.renameSync(tmp, file);
        } catch (err) {
          if (signal && signal.aborted) throw Object.assign(new Error('ยกเลิกแล้ว'), { code: 'ABORTED' });
          missing.push(id);
          continue;
        }
      }
      files[id] = file;
    }
    return { files, missing };
  }

  async _runRender(job, { spec, duration, files, quality, lines, fps = 30, target = null }) {
    try {
      const sfx = await this._ensureSfx(spec.clips, job.ac.signal);
      const extra = Object.entries(sfx.files).map(([id, file]) => ({ name: `sfx-${id}.wav`, path: file }));
      const html = hfp.buildProject({ ...spec, fonts: !!(this.hf.hasFonts && this.hf.hasFonts()), sfxFiles: Object.fromEntries(Object.keys(sfx.files).map((id) => [id, `assets/sfx-${id}.wav`])) }).html;
      const dir = this.hf.prepare(this.projectId, { html, files, extra });
      const out = path.join(dir, `${job.kind}-${++this.renderNo}.mp4`);
      await this.hf.render(dir, {
        out, quality, fps, signal: job.ac.signal,
        onProgress: (fraction, code) => {
          if (this.render !== job) return;
          Object.assign(job, { fraction, label: RENDER_LABELS[code] || 'กำลังสร้างวิดีโอ' });
          this._renderProgress();
        },
      });
      if (target) {
        const part = `${target}.part`;
        fs.copyFileSync(out, part); // never leave half a file under the real name
        fs.renameSync(part, target);
        this.lastExport = target;
        this.lastRender = { ok: true, kind: 'export', name: path.basename(target), size: fs.statSync(target).size, duration, captions: lines, elapsedMs: this.now() - job.startedAt, ...(sfx.missing.length ? { warning: `สร้างเสียงเอฟเฟกต์ไม่ได้: ${sfx.missing.map((m) => effects.SFX[m].label).join(', ')} (วิดีโอไม่มีเสียงนี้)` } : {}) };
      } else {
        const media = this.registry.add(out);
        this.lastRender = { ok: true, kind: 'preview', url: media.url, duration, captions: lines, quality, elapsedMs: this.now() - job.startedAt, ...(sfx.missing.length ? { warning: `สร้างเสียงเอฟเฟกต์ไม่ได้: ${sfx.missing.map((m) => effects.SFX[m].label).join(', ')} (วิดีโอไม่มีเสียงนี้)` } : {}) };
      }
    } catch (err) {
      this.lastRender = err.code === 'ABORTED' ? { ok: false, cancelled: true, kind: job.kind } : { ok: false, kind: job.kind, error: err.message };
    } finally {
      if (this.render === job) this.render = null;
      this._renderProgress();
      this._changed();
    }
  }

  _renderProgress() {
    const j = this.render;
    this.emit('video:render', j
      ? { running: true, kind: j.kind, fraction: j.fraction, label: j.label, elapsedMs: this.now() - j.startedAt }
      : { running: false, result: this.lastRender });
  }

  // ---------- style cut ----------

  /**
   * JARVIS edits the clips on the timeline by a style, in the background. Returns at once;
   * progress and the result arrive as 'video:cut' events. The cut replaces the timeline in
   * one step, so "ย้อนกลับ" (undo) brings the previous timeline back.
   */
  startCut({ styleId, note = '' }) {
    if (this.cut) throw new Error('JARVIS กำลังตัดต่ออยู่ — รอให้เสร็จหรือกดยกเลิกก่อน');
    const style = this.styles.get(styleId);
    if (!style) throw new Error('ไม่พบแนวนี้');
    if (!this.history.list.clips.length) throw new Error('ยังไม่มีคลิปในแถบเวลา — นำเข้าคลิปก่อน');
    const ac = new AbortController();
    this.cut = { ac, stage: 'wait', label: 'รอให้ JARVIS ฟังคลิปให้เสร็จ', overall: 0.02, startedAt: this.now(), styleName: style.name };
    this.lastCut = null;
    this._cutProgress();
    this._changed();
    this._runCut(style, String(note || '').trim().slice(0, NOTE_MAX), ac);
    return { started: true, styleName: style.name };
  }

  cancelCut() {
    if (this.cut) this.cut.ac.abort();
    return { ok: true };
  }

  async _runCut(style, note, ac) {
    const job = this.cut;
    const step = (stage, label, overall) => {
      if (this.cut !== job) return;
      Object.assign(job, { stage, label, overall });
      this._cutProgress();
    };
    const aborted = () => ac.signal.aborted;
    const abortErr = () => Object.assign(new Error('ยกเลิกแล้ว'), { code: 'ABORTED' });
    let ticker = null;
    try {
      await Promise.race([this._analysisIdle(), new Promise((resolve) => ac.signal.addEventListener('abort', resolve, { once: true }))]);
      if (aborted()) throw abortErr();

      step('prepare', 'เตรียมช่วงคลิปตามจังหวะของแนว', 0.3);
      const list = this.history.list;
      const order = [...new Set(list.clips.map((c) => c.src))];
      const sources = order.map((id) => this.sources.get(id)).filter(Boolean);
      const warnings = [];
      for (const s of sources) {
        if (!s.analysis) warnings.push(`${s.name}: ยังไม่ได้วิเคราะห์ (${s.analyzeError || 'ไม่ทราบสาเหตุ'}) จึงไม่รู้ช่วงเงียบและคำพูด`);
        else if (!s.analysis.transcript) warnings.push(`${s.name}: ยังไม่ได้ถอดเสียงพูด JARVIS จึงเลือกจากช่วงเวลาอย่างเดียว`);
      }
      const view = sources.map((s) => ({ id: s.id, name: s.name, duration: s.duration, analysis: s.analysis }));
      const pieces = buildPieces(view, style);
      if (!pieces.length) throw new Error('ไม่เหลือช่วงให้ตัด (ทั้งคลิปเงียบ)');

      const label = `JARVIS กำลังเลือกช่วงตามแนว "${style.name}"`;
      step('think', label, 0.35);
      const t0 = this.now();
      ticker = setInterval(() => step('think', label, 0.35 + 0.55 * (1 - Math.exp(-(this.now() - t0) / 40000))), 500);
      let plan;
      let byClaude = true;
      try {
        // cancel must not depend on ask() honouring the signal
        const stop = new Promise((resolve, reject) => ac.signal.addEventListener('abort', () => reject(abortErr()), { once: true }));
        const answer = await Promise.race([this.ask({ prompt: buildPlanPrompt({ style, note, pieces, sources: view }), system: SYSTEM, signal: ac.signal }), stop]);
        plan = parsePlan(answer, pieces, { targetSec: style.targetSec });
      } catch (err) {
        if (aborted() || err.code === 'ABORTED') throw abortErr();
        byClaude = false;
        warnings.push(`JARVIS ตัดตามแนวไม่สำเร็จ (${err.message}) จึงตัดแบบพื้นฐานให้แทน: ตัดช่วงเงียบตามจังหวะ เรียงตามเดิม`);
        plan = basicPlan(pieces, style);
      }
      clearInterval(ticker);
      ticker = null;
      if (aborted()) throw abortErr();

      step('apply', 'จัดลงแถบเวลา', 0.95);
      let next = { ...E.emptyList(list.sources), nextId: list.nextId, overlays: list.overlays || [], nextOverlay: list.nextOverlay || 1 }; // clip ids stay unique across undo; animations stay
      for (const c of plan.clips) next = E.addClip(next, c);
      this.history.apply(() => next);
      this.lastCut = {
        ok: true, styleName: style.name, byClaude, summary: plan.summary, warnings: [...warnings, ...plan.warnings],
        clips: plan.clips.length, length: E.totalLength(next), elapsedMs: this.now() - job.startedAt,
      };
    } catch (err) {
      this.lastCut = err.code === 'ABORTED'
        ? { ok: false, cancelled: true, styleName: style.name }
        : { ok: false, styleName: style.name, error: err.message };
    } finally {
      if (ticker) clearInterval(ticker);
      if (this.cut === job) this.cut = null;
      this._cutProgress();
      this._changed();
    }
  }

  _cutProgress() {
    const j = this.cut;
    this.emit('video:cut', j
      ? { running: true, stage: j.stage, label: j.label, overall: j.overall, styleName: j.styleName, elapsedMs: this.now() - j.startedAt }
      : { running: false, result: this.lastCut });
  }

  _progress() {
    const j = this.job;
    this.emit('video:progress', j ? { running: true, sourceId: j.sourceId, stage: j.stage, label: j.label, overall: j.overall, elapsedMs: Date.now() - j.startedAt, queued: this.queue.length } : { running: false, queued: 0 });
  }

  _changed() {
    this.emit('video:state', this.snapshot());
  }

  /** The caption lines for the preview (the same ones the render uses). */
  _previewCaptions(list) {
    const segs = {};
    for (const c of list.clips) {
      const s = this.sources.get(c.src);
      const t = s && s.analysis && s.analysis.transcript;
      if (t && !segs[c.src]) segs[c.src] = t.segments.map((g) => ({ start: g.start, end: g.end, text: g.text }));
    }
    return this._captionLines(list, segs).map((l) => ({ start: l.start, end: l.end, text: l.text }));
  }

  /** What the renderer may see: no disk paths. */
  snapshot() {
    const sources = [...this.sources.values()].map((s) => ({
      id: s.id, name: s.name, url: s.url, kind: s.kind, duration: s.duration, video: s.video, audio: s.audio,
      analysis: s.analysis && { silences: s.analysis.silences, transcript: s.analysis.transcript && { ...s.analysis.transcript, segments: s.analysis.transcript.segments.map((g, i) => ({ ...g, i })) }, summary: s.analysis.summary, warnings: s.analysis.warnings },
      analyzeError: s.analyzeError,
    }));
    const list = this.history.list;
    return {
      sources,
      clips: list.clips.map((c) => ({ ...c })),
      overlays: (list.overlays || []).map((o) => ({ ...o })),
      captions: this._previewCaptions(list),
      duration: E.totalLength(list),
      canUndo: this.history.past.length > 0,
      canRedo: this.history.future.length > 0,
      job: this.job ? { sourceId: this.job.sourceId, stage: this.job.stage, label: this.job.label, overall: this.job.overall } : null,
      render: this.render ? { kind: this.render.kind, fraction: this.render.fraction, label: this.render.label } : null,
      lastRender: this.lastRender,
      fix: this.fix ? { sourceId: this.fix.sourceId } : null,
      cut: this.cut ? { stage: this.cut.stage, label: this.cut.label, overall: this.cut.overall, styleName: this.cut.styleName } : null,
      lastCut: this.lastCut,
    };
  }
}

module.exports = { VideoService };
