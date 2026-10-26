// EDIT section: import clips, watch the cut, and see what JARVIS found in them
// (pauses, speech) on a timeline. The edit list lives in the main process
// (lib/video/service.js); this view renders its snapshots and plays them back.
// Read-only for now: editing tools come later.

import { el } from '../blocks.js';
import { StylePicker } from './video-styles.js';
import { layout, locate, timelineTime, mapRanges, fmtTime, ticks, fitZoom, frameStep, totalLength } from './video-timeline.js';

const $ = (id) => document.getElementById(id);
const LANE_LABELS = { clips: 'คลิป', silence: 'ช่วงเงียบ', speech: 'คำพูด' };

function isField(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** CSP allows styles set through the CSSOM, not style attributes in markup. */
function styled(node, css) {
  node.style.cssText = css;
  return node;
}

function hasFiles(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

export class VideoEditor {
  /** api: window.jarvis · notice(text, level) · openSettings(tab) · isOpen(): is the EDIT section showing */
  constructor({ api, notice, openSettings, isOpen }) {
    this.api = api;
    this.notice = notice;
    this.openSettings = openSettings;
    this.isOpen = isOpen;
    this.snap = { sources: [], clips: [], duration: 0, job: null };
    this.progress = { running: false };
    this.t = 0; // timeline time (seconds)
    this.playing = false;
    this.index = -1; // clip being shown
    this.loadedSrc = null;
    this.pxPerSec = 40;
    this.autoFit = true;
    this.raf = 0;
    this.seekToken = 0;

    this.root = $('video-editor');
    this.styles = new StylePicker({ api, notice });
    this.video = $('ve-video');
    this._wire();
    api.on('video:state', (s) => this.setState(s));
    api.on('video:progress', (p) => this.setProgress(p));
    api.on('video:cut', (c) => this.setCut(c));
    api.invoke('video:state').then((s) => this.setState(s)).catch(() => {});
  }

  // ---------- JARVIS cut by style ----------
  async startCut() {
    const { style, note } = this.styles.choice();
    if (!style) return this.notice('เลือกแนวคลิปก่อน', 'warn');
    this.pause();
    try {
      await this.api.invoke('video:cut-start', { styleId: style.id, note });
      this.notice(`JARVIS เริ่มตัดต่อแนว "${style.name}" แล้ว — คุยเรื่องอื่นหรือทำอย่างอื่นต่อได้เลย`, 'info', null, 5000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  /** 'video:cut' events: progress while running, then the result. */
  setCut(c) {
    this.cutState = c;
    this._renderCut();
  }

  _renderCut() {
    const box = $('ve-cut-status');
    const btn = $('ve-cut');
    const c = this.cutState;
    const running = !!(c && c.running);
    btn.disabled = running || !this.snap.clips.length;
    btn.textContent = running ? 'JARVIS กำลังตัดต่อ…' : '✂ ให้ JARVIS ตัดต่อตามแนวนี้';
    if (running) {
      const pct = Math.round((c.overall || 0) * 100);
      box.hidden = false;
      box.className = 've-cut-status cut running';
      box.replaceChildren(
        el('div', { class: 've-job-label' }, el('span', { text: c.label }), el('span', { class: 'mono', text: `${pct}%` })),
        el('div', { class: 've-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, styled(el('div', { class: 've-bar-fill' }), `width:${pct}%`)),
        el('div', { class: 've-actions' },
          el('span', { class: 'dim mono', text: fmtTime((c.elapsedMs || 0) / 1000).replace(/\.\d$/, '') }),
          el('button', { class: 'btn small', type: 'button', text: 'ยกเลิก', onclick: () => this.api.invoke('video:cut-cancel') })));
      return;
    }
    const r = c && c.result;
    if (!r) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = `ve-cut-status cut ${r.ok ? 'ok' : r.cancelled ? '' : 'bad'}`;
    if (!r.ok) {
      box.replaceChildren(el('div', { class: r.cancelled ? 'dim' : 've-err', text: r.cancelled ? `ยกเลิกการตัดแนว "${r.styleName}" แล้ว — แถบเวลาเหมือนเดิม` : `ตัดต่อไม่สำเร็จ: ${r.error}` }));
      return;
    }
    const kids = [
      el('div', { class: 've-cut-title', text: `ตัดแนว "${r.styleName}" เสร็จ · ${r.clips} ช่วง · ยาว ${fmtTime(r.length)}` }),
      r.summary ? el('div', { class: 've-sum', text: r.summary }) : null,
      ...r.warnings.map((w) => el('div', { class: 've-warn', text: w })),
      el('div', { class: 've-actions' },
        el('button', { class: 'btn small', type: 'button', text: 'เล่นดูตั้งแต่ต้น', onclick: () => { this.seek(0).then(() => this.play()); } }),
        el('button', { class: 'btn small', type: 'button', text: 'ย้อนกลับไปก่อนตัด', onclick: () => this.undo() })),
    ];
    box.replaceChildren(...kids.filter(Boolean));
  }

  async undo() {
    try {
      this.setState(await this.api.invoke('video:undo'));
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  async redo() {
    try {
      this.setState(await this.api.invoke('video:redo'));
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  // ---------- wiring ----------
  _wire() {
    $('ve-import').onclick = (e) => e.isTrusted && this.choose();
    $('ve-empty-import').onclick = (e) => e.isTrusted && this.choose();
    $('ve-clear').onclick = (e) => e.isTrusted && this.clear();
    $('ve-play').onclick = () => this.toggle();
    $('ve-start').onclick = () => this.seek(0);
    $('ve-zoom-in').onclick = () => this.zoom(1.5);
    $('ve-zoom-out').onclick = () => this.zoom(1 / 1.5);
    $('ve-zoom-fit').onclick = () => { this.autoFit = true; this.render(); };
    $('ve-ffmpeg-open').onclick = () => this.openSettings('video');
    $('ve-cut').onclick = (e) => e.isTrusted && this.startCut();
    $('ve-undo').onclick = () => this.undo();
    $('ve-redo').onclick = () => this.redo();

    // drops land here, not in the conversation's attachment handler
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    this.root.addEventListener('dragenter', (e) => { if (hasFiles(e)) { stop(e); this.root.classList.add('drop'); } });
    this.root.addEventListener('dragover', (e) => { if (hasFiles(e)) { stop(e); e.dataTransfer.dropEffect = 'copy'; } });
    this.root.addEventListener('dragleave', (e) => { if (e.target === this.root || !this.root.contains(e.relatedTarget)) this.root.classList.remove('drop'); });
    this.root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      stop(e);
      this.root.classList.remove('drop');
      const paths = [...e.dataTransfer.files].map((f) => this.api.pathForFile(f)).filter(Boolean).slice(0, 20);
      if (!paths.length) return this.notice('ลากได้เฉพาะไฟล์ในเครื่อง', 'warn');
      this.import(paths);
    });

    // timeline: click or drag to move the playhead
    const tl = $('ve-timeline');
    let dragging = false;
    const at = (e) => {
      const r = $('ve-track').getBoundingClientRect();
      return Math.max(0, Math.min(this.snap.duration, (e.clientX - r.left) / this.pxPerSec));
    };
    tl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.snap.clips.length) return;
      dragging = true;
      tl.setPointerCapture(e.pointerId);
      this.wasPlaying = this.playing;
      this.pause();
      this.seek(at(e));
    });
    tl.addEventListener('pointermove', (e) => { if (dragging) this.seek(at(e), { scrub: true }); });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { tl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (this.wasPlaying) this.play();
    };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);
    tl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });

    this.video.addEventListener('ended', () => this._clipEnded());
    this.video.addEventListener('error', () => {
      if (this.video.getAttribute('src')) this.notice('เล่นคลิปนี้ในจอพรีวิวไม่ได้ (ไฟล์บางชนิด เช่น mkv/avi อาจเล่นไม่ได้ แต่ยังตัดต่อและส่งออกได้)', 'warn');
    });
    addEventListener('resize', () => { if (this.isOpen()) this.render(); });
    addEventListener('keydown', (e) => this._key(e));
  }

  _key(e) {
    if (!this.isOpen() || isField(e.target) || e.altKey || e.metaKey) return;
    if (document.querySelector('.modal:not([hidden])')) return; // a dialog has the keys
    if (e.ctrlKey) {
      const undo = e.code === 'KeyZ' && !e.shiftKey;
      const redo = e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey);
      if (!undo && !redo) return;
      e.preventDefault();
      e.stopPropagation();
      if (undo && this.snap.canUndo) this.undo();
      if (redo && this.snap.canRedo) this.redo();
      return;
    }
    if (!this.snap.clips.length) return;
    const step = frameStep(this._fps());
    const keys = {
      Space: () => this.toggle(),
      ArrowLeft: () => { this.pause(); this.seek(this.t - (e.shiftKey ? 1 : step)); },
      ArrowRight: () => { this.pause(); this.seek(this.t + (e.shiftKey ? 1 : step)); },
      Home: () => this.seek(0),
      End: () => this.seek(this.snap.duration),
      Equal: () => this.zoom(1.5),
      NumpadAdd: () => this.zoom(1.5),
      Minus: () => this.zoom(1 / 1.5),
      NumpadSubtract: () => this.zoom(1 / 1.5),
    };
    const fn = keys[e.code];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }

  // ---------- commands ----------
  async choose() {
    if (!(await this._ffmpegReady())) return;
    const r = await this.api.invoke('video:choose').catch((err) => ({ added: [], rejected: [{ name: '', reason: err.message }] }));
    this._report(r);
  }

  async import(paths) {
    if (!(await this._ffmpegReady())) return;
    const r = await this.api.invoke('video:import', paths).catch((err) => ({ added: [], rejected: [{ name: '', reason: err.message }] }));
    this._report(r);
  }

  _report(r) {
    if (r.added.length) this.notice(`นำเข้า ${r.added.length} คลิปแล้ว — JARVIS กำลังฟังและหาช่วงเงียบ`, 'info', null, 5000);
    if (r.rejected.length) this.notice('นำเข้าไม่ได้: ' + r.rejected.map((x) => (x.name ? `${x.name} (${x.reason})` : x.reason)).join(', '), 'warn');
  }

  async clear() {
    if (!this.snap.sources.length) return;
    if (!confirm('ล้างคลิปทั้งหมดออกจากหน้าตัดต่อ? (ไฟล์ต้นฉบับไม่ถูกลบ)')) return;
    this.pause();
    this.setState(await this.api.invoke('video:reset'));
  }

  async _ffmpegReady() {
    const s = await this.api.invoke('video:ffmpeg-status').catch(() => ({ ready: false }));
    this._showFfmpeg(s);
    if (!s.ready) this.notice('ต้องมี ffmpeg ก่อนจึงจะนำเข้าคลิปได้ — ติดตั้งได้ในตั้งค่า > วิดีโอ', 'warn');
    return s.ready;
  }

  _showFfmpeg(s) {
    $('ve-ffmpeg').hidden = !!s.ready;
    $('ve-ffmpeg-text').textContent = s.error ? `ffmpeg: ${s.error}` : 'ยังไม่มี ffmpeg (โปรแกรมเบื้องหลังที่ใช้ตัดต่อ) — ติดตั้งได้ในตั้งค่า > วิดีโอ';
  }

  /** Called when the section opens. */
  onShow() {
    this.api.invoke('video:ffmpeg-status').then((s) => this._showFfmpeg(s)).catch(() => {});
    this.render();
  }

  onHide() {
    this.pause();
  }

  // ---------- state from main ----------
  setState(s) {
    if (!s) return;
    const clipsChanged = JSON.stringify(s.clips) !== JSON.stringify(this.snap.clips);
    this.snap = s;
    if (clipsChanged) {
      this.loadedSrc = null;
      this.index = -1;
      if (!s.clips.length) {
        this.pause();
        this.video.removeAttribute('src');
        this.video.load();
        this.t = 0;
      } else {
        this.seek(Math.min(this.t, s.duration));
      }
    }
    this.render();
  }

  setProgress(p) {
    this.progress = p || { running: false };
    this._renderSources();
  }

  // ---------- playback ----------
  _source(id) {
    return this.snap.sources.find((s) => s.id === id) || null;
  }

  _fps() {
    const loc = locate(this.snap.clips, this.t);
    const src = loc && this._source(loc.clip.src);
    return src && src.video ? src.video.fps : 30;
  }

  /** Shows timeline time t: loads the right file and moves to the right moment. */
  async seek(t, { scrub = false } = {}) {
    const clips = this.snap.clips;
    if (!clips.length) return;
    this.t = Math.max(0, Math.min(this.snap.duration, t));
    const loc = locate(clips, this.t);
    const token = ++this.seekToken;
    await this._show(loc, token);
    if (token !== this.seekToken) return;
    this._renderTime();
    if (!scrub) this._scrollToPlayhead();
  }

  async _show(loc, token) {
    const src = this._source(loc.clip.src);
    if (!src) return;
    this.index = loc.index;
    if (this.loadedSrc !== src.id) {
      this.loadedSrc = src.id;
      this.video.src = src.url;
      $('ve-audio-only').hidden = src.kind !== 'audio' && !!src.video;
      await new Promise((resolve) => {
        const done = () => { this.video.removeEventListener('loadedmetadata', done); this.video.removeEventListener('error', done); resolve(); };
        this.video.addEventListener('loadedmetadata', done);
        this.video.addEventListener('error', done);
      });
      if (token !== this.seekToken) return;
    }
    this.video.playbackRate = loc.clip.speed;
    const target = Math.min(loc.sourceTime, loc.clip.out - 0.001);
    if (Math.abs(this.video.currentTime - target) > 0.01) this.video.currentTime = target;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  async play() {
    if (!this.snap.clips.length) return;
    if (this.t >= this.snap.duration - 0.01) await this.seek(0);
    else if (this.index < 0) await this.seek(this.t);
    this.playing = true;
    $('ve-play').textContent = '❚❚';
    $('ve-play').setAttribute('aria-label', 'หยุดชั่วคราว');
    try {
      await this.video.play();
    } catch { /* paused again before it started */ }
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this._follow();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (!this.video.paused) this.video.pause();
    $('ve-play').textContent = '▶';
    $('ve-play').setAttribute('aria-label', 'เล่น');
  }

  /** While playing: track the time, and jump over cuts to the next clip. */
  _follow() {
    const clips = this.snap.clips;
    const clip = clips[this.index];
    if (!clip) return;
    const st = this.video.currentTime;
    if (st >= clip.out - 0.02) return this._clipEnded();
    this.t = timelineTime(clips, this.index, st);
    this._renderTime();
    this._scrollToPlayhead(true);
  }

  async _clipEnded() {
    if (!this.playing) return;
    const rows = layout(this.snap.clips);
    const next = rows[this.index + 1];
    if (!next) {
      this.pause();
      this.t = this.snap.duration;
      this._renderTime();
      return;
    }
    const token = ++this.seekToken;
    this.t = next.start;
    await this._show({ index: next.index, clip: next.clip, sourceTime: next.clip.in }, token);
    if (this.playing && token === this.seekToken) this.video.play().catch(() => {});
  }

  zoom(f) {
    this.autoFit = false;
    this.pxPerSec = Math.max(2, Math.min(400, this.pxPerSec * f));
    this.render();
    this._scrollToPlayhead();
  }

  // ---------- rendering ----------
  render() {
    const has = this.snap.sources.length > 0;
    $('ve-empty').hidden = has;
    $('ve-work').hidden = !has;
    $('ve-clear').disabled = !has;
    if (!has) return;
    this._renderPreviewShape();
    this._renderSources();
    this._renderTimeline();
    this._renderTime();
  }

  _renderPreviewShape() {
    const first = this.snap.sources.find((s) => s.video && s.video.width && s.video.height);
    const ratio = first ? `${first.video.width} / ${first.video.height}` : '9 / 16';
    $('ve-preview').style.setProperty('--ve-ratio', ratio);
  }

  _renderSources() {
    const box = $('ve-sources');
    if (!box) return;
    box.replaceChildren(...this.snap.sources.map((s) => this._sourceCard(s)));
    const words = [];
    for (const s of this.snap.sources) {
      const segs = s.analysis && s.analysis.transcript ? s.analysis.transcript.segments : [];
      for (const g of mapRanges(this.snap.clips, s.id, segs)) words.push(g);
    }
    words.sort((a, b) => a.start - b.start);
    const list = $('ve-transcript');
    list.replaceChildren(...(words.length
      ? words.map((w) => el('li', {},
        el('button', { class: 've-line', type: 'button', title: 'ไปที่ประโยคนี้', onclick: () => { this.pause(); this.seek(w.start); } },
          el('span', { class: 'mono dim', text: fmtTime(w.start) }), el('span', { text: w.text }))))
      : [el('li', { class: 'dim', text: this.progress.running ? 'กำลังถอดเสียงพูด…' : 'ยังไม่มีคำพูดที่ถอดได้' })]));
  }

  _sourceCard(s) {
    const job = this.progress.running && this.progress.sourceId === s.id ? this.progress : null;
    const size = s.video ? `${s.video.width}×${s.video.height}${s.video.fps ? ` · ${Math.round(s.video.fps)} fps` : ''}` : 'เสียงอย่างเดียว';
    const card = el('div', { class: 've-src cut' },
      el('div', { class: 've-src-head' }, el('span', { class: 've-src-name', text: s.name, title: s.name }), el('span', { class: 'mono dim', text: fmtTime(s.duration) })),
      el('div', { class: 'mono dim ve-src-meta', text: size }));
    if (job) {
      const pct = Math.round((job.overall || 0) * 100);
      card.append(
        el('div', { class: 've-job' },
          el('div', { class: 've-job-label' }, el('span', { text: `${job.label}…` }), el('span', { class: 'mono', text: `${pct}%` })),
          el('div', { class: 've-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, styled(el('div', { class: 've-bar-fill' }), `width:${pct}%`)),
          el('button', { class: 'btn small', type: 'button', text: 'ยกเลิก', onclick: () => this.api.invoke('video:cancel') })));
    } else if (s.analyzeError) {
      card.append(el('div', { class: 've-err', text: s.analyzeError }),
        el('button', { class: 'btn small', type: 'button', text: 'วิเคราะห์ใหม่', onclick: () => this.api.invoke('video:analyze', s.id) }));
    } else if (s.analysis) {
      const m = s.analysis.summary;
      const lines = s.analysis.transcript ? `ถอดเสียง ${m.segments} ประโยค` : 'ยังไม่ได้ถอดเสียง';
      card.append(el('div', { class: 've-sum' }, `พูด ${fmtTime(m.speechSec)} · เงียบ ${fmtTime(m.silenceSec)} (${m.silences} ช่วง) · ${lines}`));
      for (const w of s.analysis.warnings || []) {
        card.append(el('div', { class: 've-warn', text: w.message }));
        if (w.code === 'NO_WHISPER' || w.code === 'NO_MODEL') {
          card.append(el('div', { class: 've-actions' },
            el('button', { class: 'btn small', type: 'button', text: 'ไปติดตั้งตัวถอดเสียง', onclick: () => this.openSettings('voice') }),
            el('button', { class: 'btn small', type: 'button', text: 'วิเคราะห์ใหม่', onclick: () => this.api.invoke('video:analyze', s.id) })));
        }
      }
    } else if (this.progress.running) {
      card.append(el('div', { class: 'dim', text: 'รอคิววิเคราะห์' }));
    }
    return card;
  }

  _renderTimeline() {
    const scroller = $('ve-timeline');
    const width = Math.max(200, scroller.clientWidth - 24);
    const duration = this.snap.duration;
    if (this.autoFit) this.pxPerSec = fitZoom(duration, width);
    const px = (t) => `${(t * this.pxPerSec).toFixed(1)}px`;
    const track = $('ve-track');
    track.style.width = px(duration);

    const { list } = ticks(duration, this.pxPerSec);
    $('ve-ruler').replaceChildren(...list.map((k) => styled(el('span', { class: 've-tick', text: fmtTime(k.t).replace(/\.0$/, '') }), `left:${px(k.t)}`)));

    const rows = layout(this.snap.clips);
    $('ve-lane-clips').replaceChildren(...rows.map((r) => {
      const src = this._source(r.clip.src);
      const b = el('div', { class: `ve-clip ve-c${(Number(String(r.clip.src).slice(1)) || 0) % 4}`, title: `${src ? src.name : ''} · ${fmtTime(r.end - r.start)}` },
        el('span', { class: 've-clip-name', text: src ? src.name : r.clip.src }),
        r.clip.speed !== 1 ? el('span', { class: 've-clip-speed mono', text: `${r.clip.speed}×` }) : null);
      b.style.cssText = `left:${px(r.start)};width:${px(r.end - r.start)}`;
      return b;
    }));

    const silences = [];
    const speech = [];
    for (const s of this.snap.sources) {
      if (!s.analysis) continue;
      silences.push(...mapRanges(this.snap.clips, s.id, s.analysis.silences));
      if (s.analysis.transcript) speech.push(...mapRanges(this.snap.clips, s.id, s.analysis.transcript.segments));
    }
    $('ve-lane-silence').replaceChildren(...silences.map((g) => {
      const b = el('div', { class: 've-sil', title: `เงียบ ${fmtTime(g.end - g.start)}` });
      b.style.cssText = `left:${px(g.start)};width:${px(g.end - g.start)}`;
      return b;
    }));
    $('ve-lane-speech').replaceChildren(...speech.map((g) => {
      const b = el('div', { class: 've-say', title: g.text }, el('span', { text: g.text }));
      b.style.cssText = `left:${px(g.start)};width:${px(g.end - g.start)}`;
      return b;
    }));
    for (const [k, label] of Object.entries(LANE_LABELS)) $(`ve-label-${k}`).textContent = label;
  }

  _renderTime() {
    const d = this.snap.duration || totalLength(this.snap.clips);
    $('ve-time').textContent = `${fmtTime(this.t)} / ${fmtTime(d)}`;
    $('ve-playhead').style.left = `${(this.t * this.pxPerSec).toFixed(1)}px`;
  }

  _scrollToPlayhead(onlyIfOut = false) {
    const sc = $('ve-timeline');
    const x = this.t * this.pxPerSec;
    const left = sc.scrollLeft;
    const w = sc.clientWidth - 48;
    if (onlyIfOut && x >= left && x <= left + w) return;
    if (!onlyIfOut || x < left || x > left + w) sc.scrollLeft = Math.max(0, x - w * 0.3);
  }
}
