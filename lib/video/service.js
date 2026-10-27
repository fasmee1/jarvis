'use strict';
// The editor's state in the main process: imported clips, the one edit list, the
// analysis jobs (one at a time, queued) and the style cut (JARVIS edits by a style,
// in the background). The renderer only ever sees snapshots (no disk paths) and
// changes things through IPC that calls these methods.

const path = require('path');
const E = require('./edit-list');
const captions = require('./captions');
const { buildPieces, buildPlanPrompt, parsePlan, basicPlan, SYSTEM } = require('./planner');

const NOTE_MAX = 1000;

class VideoService {
  /**
   * registry: MediaRegistry · ffmpeg: Ffmpeg · analyzer: ClipAnalyzer · styles: StyleStore
   * ask({ prompt, system, signal }) → Claude's answer text (lib/video/ask-claude.js)
   * emit(channel, payload): 'video:state' snapshots, 'video:progress' analysis updates,
   * 'video:cut' style-cut updates.
   */
  constructor({ registry, ffmpeg, analyzer, styles, ask, emit = () => {}, now = () => Date.now() }) {
    this.registry = registry;
    this.ffmpeg = ffmpeg;
    this.analyzer = analyzer;
    this.styles = styles;
    this.ask = ask;
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
      let next = { ...E.emptyList(list.sources), nextId: list.nextId }; // clip ids stay unique across undo
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
      duration: E.totalLength(list),
      canUndo: this.history.past.length > 0,
      canRedo: this.history.future.length > 0,
      job: this.job ? { sourceId: this.job.sourceId, stage: this.job.stage, label: this.job.label, overall: this.job.overall } : null,
      fix: this.fix ? { sourceId: this.fix.sourceId } : null,
      cut: this.cut ? { stage: this.cut.stage, label: this.cut.label, overall: this.cut.overall, styleName: this.cut.styleName } : null,
      lastCut: this.lastCut,
    };
  }
}

module.exports = { VideoService };
