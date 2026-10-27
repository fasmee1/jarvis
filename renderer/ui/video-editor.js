// EDIT section: import clips, watch the cut, and see what JARVIS found in them
// (pauses, speech) on a timeline. The edit list lives in the main process
// (lib/video/service.js); this view renders its snapshots and plays them back.
// Read-only for now: editing tools come later.

import { el } from '../blocks.js';
import { StylePicker } from './video-styles.js';
import { FxLayer, buildCues, cuesBetween } from './video-preview.js';
import { layout, locate, timelineTime, mapRanges, fmtTime, ticks, fitZoom, frameStep, totalLength } from './video-timeline.js';

const $ = (id) => document.getElementById(id);
const LANE_LABELS = { clips: 'คลิป', silence: 'ช่วงเงียบ', speech: 'คำพูด', anim: 'อนิเมชั่น' };
const OV_NAMES = { title: 'หัวข้อ', lower: 'ป้ายชื่อ', counter: 'ตัวเลข' };

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

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MIN_CLIP = 0.1; // keep in step with lib/video/edit-list.js
const DRAG_PX = 4;

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
    this.sel = null; // id of the selected clip
    this.editing = null; // { srcId, i }: a transcript line being typed over
    this.ovEditing = null; // id of the animation loaded in the form

    this.root = $('video-editor');
    this.styles = new StylePicker({ api, notice });
    this.video = $('ve-video');
    this.fx = new FxLayer($('ve-fx-layer'), this.video);
    this._wire();
    api.on('video:state', (s) => this.setState(s));
    api.on('video:progress', (p) => this.setProgress(p));
    api.on('video:cut', (c) => this.setCut(c));
    api.on('video:render', (c) => this.setRenderState(c));
    api.on('video:sfx', (c) => this.setSfxState(c));
    this.sounds = [];
    this.images = [];
    this._soundsKey = '';
    this._imagesKey = '';
    this.cues = [];
    this.playingSfx = new Set();
    this.presets = [];
    api.invoke('video:export-presets').then((r) => this._fillPresets(r)).catch(() => {});
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
    btn.textContent = running ? 'JARVIS กำลังตัดต่อ…' : '✂ ให้ JARVIS ตัดต่อให้ทั้งหมด';
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
      ...(r.done || []).map((d) => el('div', { class: 've-sum', text: `✓ ${d}` })),
      ...r.warnings.map((w) => el('div', { class: 've-warn', text: w })),
      el('div', { class: 've-actions' },
        el('button', { class: 'btn small', type: 'button', text: 'เล่นดูตั้งแต่ต้น', onclick: () => { this.seek(0).then(() => this.play()); } }),
        el('button', { class: 'btn small', type: 'button', text: 'ย้อนกลับไปก่อนตัดต่อ', onclick: () => this.undo() })),
    ];
    box.replaceChildren(...kids.filter(Boolean));
  }

  // ---------- animations over the picture ----------
  /** Shows the inputs the chosen kind needs. */
  _ovFields() {
    const kind = $('ve-ov-kind').value;
    $('ve-ov-text').placeholder = kind === 'counter' ? 'คำใต้ตัวเลข เช่น ผู้ติดตาม (ไม่บังคับ)' : kind === 'lower' ? 'ชื่อ เช่น ฟัซมี' : 'ข้อความหัวข้อ เช่น ข้อ 1 ห้ามพลาด!';
    const sticker = !!(this.stickers && this.stickers[kind]);
    const pic = kind === 'emoji';
    $('ve-ov-text').hidden = sticker || pic;
    for (const id of ['ve-ov-pos', 've-ov-size']) $(id).hidden = !(sticker || pic);
    $('ve-ov-color').hidden = !sticker;
    $('ve-ov-image').hidden = !pic;
    $('ve-ov-text2').hidden = kind !== 'lower';
    for (const id of ['ve-ov-from', 've-ov-to', 've-ov-suffix']) $(id).hidden = kind !== 'counter';
  }

  /** "เพิ่มหัวข้อ …": starts at the playhead and stays 3 s (3.5 s for a counter). */
  async addOverlayByVoice(overlay) {
    const start = Math.round(this.t * 10) / 10;
    const ok = await this.edit({ op: 'overlay-add', overlay: { ...overlay, start, end: start + (overlay.kind === 'counter' ? 3.5 : 3) } });
    if (ok) this.notice(`เพิ่ม${OV_NAMES[overlay.kind]}ที่ ${fmtTime(start)} แล้ว — ปรับเวลาและข้อความได้ที่ช่อง "อนิเมชั่นซ้อนคลิป"`, 'info', null, 4000);
    return ok;
  }

  /** "ลบอนิเมชั่น": the one on screen at the playhead, else the last added; "ทั้งหมด" removes every one. */
  async removeOverlayByVoice(all) {
    const items = this.snap.overlays || [];
    if (!items.length) return this.notice('ยังไม่มีอนิเมชั่นให้ลบ', 'info', null, 3000);
    if (all) {
      for (const o of items) await this.edit({ op: 'overlay-remove', id: o.id });
      this._ovReset();
      return true;
    }
    const target = items.find((o) => this.t >= o.start && this.t <= o.end) || items[items.length - 1];
    if (this.ovEditing === target.id) this._ovReset();
    return this.edit({ op: 'overlay-remove', id: target.id });
  }

  _ovReset() {
    this.ovEditing = null;
    $('ve-ov-text').value = '';
    $('ve-ov-text2').value = '';
    $('ve-ov-from').value = '';
    $('ve-ov-to').value = '';
    $('ve-ov-suffix').value = '';
    $('ve-ov-start').value = '';
    $('ve-ov-sfx').value = 'none';
    $('ve-ov-size').value = '20';
    $('ve-ov-save').textContent = '＋ เพิ่มอนิเมชั่น';
    $('ve-ov-cancel').hidden = true;
    this._ovFields();
    this._renderOverlays();
  }

  /** Puts an existing animation in the form so it can be changed. */
  loadOverlay(o) {
    this.ovEditing = o.id;
    $('ve-ov-kind').value = o.kind;
    $('ve-ov-text').value = o.text;
    $('ve-ov-text2').value = o.text2 || '';
    $('ve-ov-from').value = o.kind === 'counter' ? String(o.from) : '';
    $('ve-ov-to').value = o.kind === 'counter' ? String(o.to) : '';
    $('ve-ov-suffix').value = o.suffix || '';
    $('ve-ov-start').value = String(o.start);
    $('ve-ov-len').value = String(Math.round((o.end - o.start) * 10) / 10);
    $('ve-ov-sfx').value = o.sfx || 'none';
    if ((this.stickers && this.stickers[o.kind]) || o.kind === 'emoji') {
      const near = (this.places || []).reduce((best, p) => (Math.hypot(p.x - o.x, p.y - o.y) < Math.hypot(best.x - o.x, best.y - o.y) ? p : best), this.places[0] || { x: 50, y: 50, id: 'center' });
      $('ve-ov-pos').value = near.id;
      $('ve-ov-size').value = String(o.size);
      if (o.color) $('ve-ov-color').value = o.color;
      if (o.image) $('ve-ov-image').value = o.image;
    }
    $('ve-ov-save').textContent = 'บันทึกการแก้';
    $('ve-ov-cancel').hidden = false;
    this._ovFields();
    this._renderOverlays();
  }

  async saveOverlay() {
    const kind = $('ve-ov-kind').value;
    const num = (id) => { const x = $(id).value.trim(); return x === '' ? undefined : Number(x); };
    const startIn = num('ve-ov-start');
    const start = startIn === undefined ? Math.round(this.t * 10) / 10 : startIn;
    const len = num('ve-ov-len') || 3;
    const overlay = { kind, text: $('ve-ov-text').value, start, end: start + len, sfx: $('ve-ov-sfx').value || 'none' };
    if ((this.stickers && this.stickers[kind]) || kind === 'emoji') {
      const place = (this.places || []).find((p) => p.id === $('ve-ov-pos').value) || { x: 50, y: 50 };
      Object.assign(overlay, { x: place.x, y: place.y, size: Number($('ve-ov-size').value) || 20 });
      if (kind === 'emoji') overlay.image = $('ve-ov-image').value;
      else overlay.color = $('ve-ov-color').value;
      delete overlay.text;
    }
    if (kind === 'lower') overlay.text2 = $('ve-ov-text2').value;
    if (kind === 'counter') {
      overlay.from = num('ve-ov-from') ?? 0;
      overlay.to = num('ve-ov-to');
      overlay.suffix = $('ve-ov-suffix').value;
      if (overlay.to === undefined) return this.notice('ใส่ตัวเลขปลายทางช่อง "ถึง" ก่อน', 'warn');
    }
    const ok = await this.edit(this.ovEditing ? { op: 'overlay-update', id: this.ovEditing, overlay } : { op: 'overlay-add', overlay });
    if (ok) this._ovReset();
  }

  _renderOverlays() {
    const list = $('ve-ov-list');
    const items = this.snap.overlays || [];
    this._ovFields();
    list.replaceChildren(...(items.length
      ? items.map((o) => el('li', { class: o.id === this.ovEditing ? 've-ov-row on' : 've-ov-row' },
        el('button', { class: 've-line', type: 'button', title: 'ไปที่อนิเมชั่นนี้', onclick: () => { this.pause(); this.seek(o.start); } },
          el('span', { class: 'mono dim', text: fmtTime(o.start) }),
          el('span', { text: `${OV_NAMES[o.kind] || o.kind}${o.text ? `: ${o.text}` : o.kind === 'counter' ? `: ${o.from} → ${o.to}${o.suffix}` : ''}` })),
        el('span', { class: 've-line-tools show' },
          el('button', { class: 've-mini', type: 'button', title: 'แก้', 'aria-label': 'แก้อนิเมชั่น', text: '✎', onclick: () => this.loadOverlay(o) }),
          el('button', { class: 've-mini', type: 'button', title: 'ลบ', 'aria-label': 'ลบอนิเมชั่น', text: '🗑', onclick: () => { if (this.ovEditing === o.id) this._ovReset(); this.edit({ op: 'overlay-remove', id: o.id }); } }))))
      : [el('li', { class: 'dim', text: 'ยังไม่มีอนิเมชั่น — เลื่อนหัวอ่านไปจุดที่ต้องการ แล้วกดเพิ่ม' })]));
  }

  // ---------- sounds from the web ----------
  async _loadSounds() {
    try {
      this.sounds = await this.api.invoke('video:sfx-list');
    } catch {
      return;
    }
    this._fillSounds();
    this._buildCues();
    this._renderSfx();
  }

  /** The "sound" choices (clip and animation): the built-in ones, then the ones fetched. */
  _fillSounds() {
    const list = this.sounds.length ? this.sounds : (this.builtinSfx || []).map((x) => ({ ...x, custom: false }));
    if (!list.length) return;
    this.sfxLabels = Object.fromEntries(list.map((x) => [x.id, x.label]));
    const opts = list.map((x) => el('option', { value: x.id, text: x.id === 'none' ? 'เสียง: ไม่มี' : `เสียง: ${x.custom ? '🌐 ' : ''}${x.label}` }));
    const keepClip = $('ve-sfx').value;
    const keepOv = $('ve-ov-sfx').value;
    $('ve-sfx').replaceChildren(...opts);
    $('ve-ov-sfx').replaceChildren(...list.map((x) => el('option', { value: x.id, text: x.id === 'none' ? 'ไม่มีเสียง' : `${x.custom ? '🌐 ' : ''}${x.label}` })));
    if (keepClip) $('ve-sfx').value = keepClip;
    if (keepOv) $('ve-ov-sfx').value = keepOv;
    this._renderTools();
  }

  async _loadImages() {
    try {
      this.images = (await this.api.invoke('video:assets')).images;
    } catch {
      return;
    }
    this.fx.key = '';
    this._fillImages();
    this._renderEmoji();
    this._paintFx();
  }

  /** The picture choices of an "emoji" animation. */
  _fillImages() {
    const keep = $('ve-ov-image').value;
    $('ve-ov-image').replaceChildren(...(this.images.length ? this.images.map((x) => el('option', { value: x.id, text: x.label })) : [el('option', { value: '', text: 'ยังไม่มีอิโมจิในคลัง' })]));
    if (keep) $('ve-ov-image').value = keep;
  }

  async addEmoji(auto) {
    const query = auto ? '' : $('ve-emoji-q').value.trim();
    if (!auto && !query) return this.notice('พิมพ์อิโมจิ (เช่น 🔥) หรือคำ (เช่น ไฟ) ก่อน', 'warn');
    try {
      await this.api.invoke('video:emoji-find', { query });
      this.notice(auto ? 'JARVIS กำลังเลือกอิโมจิให้ตรงกับคำพูด — ทำอย่างอื่นต่อได้' : 'กำลังเพิ่มอิโมจิเข้าคลัง', 'info', null, 4000);
      if (!auto) $('ve-emoji-q').value = '';
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  _renderEmoji() {
    const list = $('ve-emoji-list');
    $('ve-emoji-add').disabled = !!(this.sfxState && this.sfxState.running);
    $('ve-emoji-auto').disabled = !!(this.sfxState && this.sfxState.running) || !this.snap.clips.length;
    list.replaceChildren(...(this.images.length ? this.images.map((x) => el('li', { class: 've-emoji-item', title: `${x.label} · ${x.license}` },
      el('img', { src: x.url, alt: x.label, width: '36', height: '36' }),
      el('button', { class: 've-mini', type: 'button', title: 'เอาออกจากคลัง (อนิเมชั่นที่ใช้อยู่จะถูกลบด้วย)', 'aria-label': 'เอาอิโมจิออกจากคลัง', text: '🗑', onclick: () => { if (confirm(`เอาอิโมจิ "${x.label}" ออกจากคลัง? อนิเมชั่นที่ใช้อิโมจินี้จะถูกลบด้วย`)) this.api.invoke('video:sfx-remove', { id: x.id }).then((s) => this.setState(s)).catch((err) => this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn')); } }))) : [el('li', { class: 'dim', text: 'ยังไม่มีอิโมจิในคลัง' })]));
  }

  /** The moments on the timeline where a sound starts (rebuilt whenever the timeline or the sounds change). */
  _buildCues() {
    const sounds = Object.fromEntries(this.sounds.filter((x) => x.url).map((x) => [x.id, x]));
    this.cues = buildCues(layout(this.snap.clips), this.snap.overlays || [], sounds);
  }

  /** While playing: start the sounds the playhead just passed. */
  _fireCues(from, to) {
    for (const c of cuesBetween(this.cues, from, to)) {
      try {
        const a = new Audio(c.url);
        a.volume = 0.9;
        this.playingSfx.add(a);
        a.addEventListener('ended', () => this.playingSfx.delete(a));
        a.play().catch(() => this.playingSfx.delete(a));
      } catch { /* no sound device */ }
    }
  }

  _stopSfx() {
    for (const a of this.playingSfx) { try { a.pause(); } catch { /* gone */ } }
    this.playingSfx.clear();
  }

  async findSounds(auto) {
    const query = auto ? '' : $('ve-sfx-q').value.trim();
    if (!auto && !query) return this.notice('พิมพ์คำที่อยากหาก่อน เช่น whoosh', 'warn');
    try {
      await this.api.invoke('video:sfx-find', { query });
      this.notice(auto ? 'JARVIS กำลังค้นเว็บหาเสียงให้ — ใช้เวลาราว 1–2 นาที ทำอย่างอื่นต่อได้' : `กำลังค้นหาเสียง "${query}" — ใช้เวลาราว 1–2 นาที`, 'info', null, 5000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  setSfxState(c) {
    this.sfxState = c;
    this._renderSfx();
  }

  _renderSfx() {
    const box = $('ve-sfx-status');
    const c = this.sfxState;
    const running = !!(c && c.running);
    $('ve-sfx-find').disabled = running;
    $('ve-sfx-auto').disabled = running || !this.snap.clips.length;
    if (running) {
      box.hidden = false;
      box.className = 've-cut-status cut running';
      box.replaceChildren(
        el('div', { class: 've-job-label' }, el('span', { text: c.label || 'กำลังหาเสียง' }), el('span', { class: 'dim mono', text: fmtTime((c.elapsedMs || 0) / 1000).replace(/\.\d$/, '') })),
        el('div', { class: 've-actions' }, el('button', { class: 'btn small', type: 'button', text: 'ยกเลิก', onclick: () => this.api.invoke('video:sfx-cancel') })));
    } else if (c && c.result) {
      const r = c.result;
      box.hidden = false;
      box.className = `ve-cut-status cut ${r.ok ? 'ok' : r.cancelled ? '' : 'bad'}`;
      if (!r.ok) box.replaceChildren(el('div', { class: r.cancelled ? 'dim' : 've-err', text: r.cancelled ? 'ยกเลิกการหาเสียงแล้ว' : `หาเสียงไม่สำเร็จ: ${r.error}` }));
      else {
        box.replaceChildren(
          el('div', { class: 've-cut-title', text: r.emoji ? (r.auto ? `ใส่อิโมจิ ${r.assigned} จุดแล้ว (ย้อนกลับได้ในขั้นเดียว)` : `เพิ่มอิโมจิเข้าคลังแล้ว: ${r.added.join(' ')}`) : r.auto ? `ใส่เสียงให้ ${r.assigned} จุดแล้ว · โหลดใหม่ ${r.added.length} เสียง` : `โหลดเสียงแล้ว ${r.added.length} เสียง: ${r.added.join(', ')}` }),
          ...r.failed.map((f) => el('div', { class: 've-warn', text: f })),
          el('div', { class: 'dim', text: r.emoji ? (r.auto ? 'แก้ตำแหน่ง/ขนาด หรือลบได้ที่รายการ "อนิเมชั่นซ้อนคลิป"' : 'ใช้ได้ที่ "อนิเมชั่นซ้อนคลิป" เลือกชนิด "อิโมจิ (จากคลัง)"') : r.auto ? 'ย้อนกลับด้วยปุ่ม "ย้อนกลับ" ได้ในขั้นเดียว · เปลี่ยนเสียงของแต่ละช่วงได้ที่ช่อง "เสียง"' : 'เลือกใช้ได้ที่ช่อง "เสียง" ของคลิปหรืออนิเมชั่น' }));
      }
    } else box.hidden = true;

    const list = $('ve-sfx-list');
    const mine = this.sounds.filter((x) => x.custom);
    list.replaceChildren(...(mine.length ? mine.map((x) => el('li', { class: 've-ov-row' },
      el('button', { class: 've-line', type: 'button', title: `เล่นฟัง · ${x.license}${x.sourcePage ? `\nที่มา: ${x.sourcePage}` : ''}`, onclick: () => { try { const a = new Audio(x.url); a.volume = 0.8; a.play(); } catch { /* no sound device */ } } },
        el('span', { class: 'mono dim', text: `${x.seconds}s` }), el('span', { text: `▶ ${x.label} · ${x.host}` })),
      el('span', { class: 've-line-tools show' },
        el('button', { class: 've-mini', type: 'button', title: 'เอาออกจากคลัง', 'aria-label': 'เอาเสียงออกจากคลัง', text: '🗑', onclick: () => { if (confirm(`เอาเสียง "${x.label}" ออกจากคลัง? ที่ใช้อยู่จะกลายเป็นไม่มีเสียง`)) this.api.invoke('video:sfx-remove', { id: x.id }).then((s) => this.setState(s)).catch((err) => this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn')); } }))))
      : [el('li', { class: 'dim', text: 'ยังไม่มีเสียงที่โหลดไว้' })]));
  }

  // ---------- video with subtitles (HyperFrames) ----------
  async startRender() {
    this.pause();
    try {
      await this.api.invoke('video:render-start', { captionStyle: $('ve-cap-style').value, quality: 'draft' });
      this.notice('JARVIS เริ่มสร้างวิดีโอพร้อมซับแล้ว — คุยเรื่องอื่นหรือทำอย่างอื่นต่อได้', 'info', null, 5000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  _fillPresets({ presets, fits, fx, sfx, fxOut, stickers = [], places = [] }) {
    this.presets = presets;
    this.stickers = Object.fromEntries(stickers.map((x) => [x.id, x]));
    this.places = places;
    for (const x of stickers) OV_NAMES[x.id] = x.label;
    const kind = $('ve-ov-kind');
    OV_NAMES.emoji = 'อิโมจิ';
    if (![...kind.options].some((o) => o.value === 'emoji')) kind.append(el('option', { value: 'emoji', text: 'อิโมจิ (จากคลัง)' }));
    for (const x of stickers) if (![...kind.options].some((o) => o.value === x.id)) kind.append(el('option', { value: x.id, text: x.label }));
    $('ve-ov-pos').replaceChildren(...places.map((p) => el('option', { value: p.id, text: p.label })));
    $('ve-ov-pos').value = 'center';
    this.fx.key = '';
    this.fxLabels = Object.fromEntries(fx.map((x) => [x.id, x.label]));
    this.sfxLabels = Object.fromEntries(sfx.map((x) => [x.id, x.label]));
    this.fxOutLabels = Object.fromEntries(fxOut.map((x) => [x.id, x.label]));
    $('ve-fxout').replaceChildren(...fxOut.map((x) => el('option', { value: x.id, text: x.id === 'none' ? 'ออก: ไม่มี' : `ออก: ${x.label}` })));
    $('ve-fx').replaceChildren(...fx.map((x) => el('option', { value: x.id, text: x.id === 'none' ? 'ภาพ: ไม่มีเอฟเฟกต์' : `ภาพ: ${x.label}` })));
    this.builtinSfx = sfx;
    this._fillSounds();
    this._renderTools();
    $('ve-preset').replaceChildren(...presets.map((x) => el('option', { value: x.id, text: `${x.label} · ${x.width}×${x.height}` })));
    $('ve-fit').replaceChildren(...fits.map((x) => el('option', { value: x.id, text: x.label })));
    this._renderExportNote();
  }

  /** The place's length limit against the timeline now. */
  _renderExportNote() {
    const p = this.presets.find((x) => x.id === $('ve-preset').value);
    const d = this.snap.duration || 0;
    const t = (s) => (s >= 60 ? `${Math.floor(s / 60)} นาที${s % 60 ? ` ${Math.round(s % 60)} วินาที` : ''}` : `${Math.round(s)} วินาที`);
    let note = '';
    if (p && d > 0) {
      if (p.maxSec && d > p.maxSec) note = `ยาว ${t(d)} เกินที่ ${p.label} รับได้ (สูงสุด ${t(p.maxSec)}) — ตัดให้สั้นลงก่อน`;
      else if (p.tipSec && d > p.tipSec) note = `ยาว ${t(d)} — ${p.label} ที่ได้คนดูจนจบมักไม่เกิน ${t(p.tipSec)}`;
    }
    $('ve-export-note').textContent = note;
  }

  async startExport() {
    this.pause();
    try {
      const r = await this.api.invoke('video:export-start', { captionStyle: $('ve-cap-style').value, preset: $('ve-preset').value, fit: $('ve-fit').value });
      if (r.cancelled) return;
      this.notice('JARVIS เริ่มส่งออกไฟล์แล้ว — คุยเรื่องอื่นหรือทำอย่างอื่นต่อได้', 'info', null, 5000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  /** 'video:render' events: progress while running, then the result. */
  setRenderState(c) {
    this.renderState = c;
    this._renderRender();
  }

  _renderRender() {
    const box = $('ve-render-status');
    const btn = $('ve-render');
    const c = this.renderState;
    const running = !!(c && c.running);
    btn.disabled = running || !this.snap.clips.length || !!(this.cutState && this.cutState.running);
    btn.textContent = running ? 'กำลังสร้างวิดีโอ…' : '🎬 สร้างตัวอย่างพร้อมซับ';
    $('ve-export').disabled = btn.disabled;
    if (running) {
      const pct = Math.round((c.fraction || 0) * 100);
      box.hidden = false;
      box.className = 've-cut-status cut running';
      box.replaceChildren(
        el('div', { class: 've-job-label' }, el('span', { text: `${c.kind === 'export' ? 'ส่งออก: ' : ''}${c.label || 'กำลังสร้างวิดีโอ'}` }), el('span', { class: 'mono', text: `${pct}%` })),
        el('div', { class: 've-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, styled(el('div', { class: 've-bar-fill' }), `width:${pct}%`)),
        el('div', { class: 've-actions' },
          el('span', { class: 'dim mono', text: fmtTime((c.elapsedMs || 0) / 1000).replace(/\.\d$/, '') }),
          el('button', { class: 'btn small', type: 'button', text: 'ยกเลิก', onclick: () => this.api.invoke('video:render-cancel') })));
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
      box.replaceChildren(el('div', { class: r.cancelled ? 'dim' : 've-err', text: r.cancelled ? (r.kind === 'export' ? 'ยกเลิกการส่งออกแล้ว' : 'ยกเลิกการสร้างวิดีโอแล้ว') : `${r.kind === 'export' ? 'ส่งออกไม่สำเร็จ' : 'สร้างวิดีโอไม่สำเร็จ'}: ${r.error}` }));
      return;
    }
    if (r.kind === 'export') {
      const mb = (r.size / 1048576).toFixed(r.size < 10485760 ? 1 : 0);
      box.replaceChildren(
        el('div', { class: 've-cut-title', text: `ส่งออกแล้ว · ${r.name} · ${mb} MB` }),
        el('div', { class: 'dim', text: `ยาว ${fmtTime(r.duration)} · ${r.captions} บรรทัดซับ · ใช้เวลา ${Math.round((r.elapsedMs || 0) / 1000)} วินาที` }),
        el('div', { class: 've-actions' },
          el('button', { class: 'btn small', type: 'button', text: 'เปิดโฟลเดอร์', onclick: () => this.api.invoke('video:export-reveal').catch((err) => this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn')) })));
      return;
    }
    const player = el('video', { class: 've-render-video', controls: '', playsinline: '', preload: 'metadata', src: r.url });
    box.replaceChildren(
      el('div', { class: 've-cut-title', text: `สร้างวิดีโอแล้ว · ${r.captions} บรรทัดซับ · ยาว ${fmtTime(r.duration)} · ใช้เวลา ${Math.round((r.elapsedMs || 0) / 1000)} วินาที` }),
      player,
      el('div', { class: 'dim', text: 'ตัวอย่างนี้สร้างจากแถบเวลาและซับตอนกดปุ่ม — แก้ซับหรือตัดต่อเพิ่มแล้วกดสร้างใหม่ได้ (ไฟล์ต้นฉบับไม่ถูกแตะ)' }));
  }

  // ---------- words of the transcript ----------
  async captionCall(channel, payload, okText) {
    try {
      this.setState(await this.api.invoke(channel, payload));
      if (okText) this.notice(okText, 'info', null, 3000);
      return true;
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
      return false;
    }
  }

  startCaptionEdit(srcId, i) {
    this.editing = { srcId, i };
    this._renderTranscript();
    const box = document.querySelector('#ve-transcript .ve-line-input');
    if (box) { box.focus(); box.select(); }
  }

  async finishCaptionEdit(save, text) {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    if (save) await this.captionCall('video:caption-edit', { sourceId: e.srcId, i: e.i, text });
    this._renderSources();
  }

  /** JARVIS checks the words of every clip that has a transcript, one after the other. */
  async fixCaptions() {
    const withText = this.snap.sources.filter((s) => s.analysis && s.analysis.transcript && s.analysis.transcript.segments.length);
    if (!withText.length) return this.notice('ยังไม่มีคำพูดที่ถอดได้ให้ตรวจ', 'warn');
    const hint = $('ve-fix-hint').value;
    this.notice('JARVIS กำลังตรวจคำที่ถอดผิด — คุยเรื่องอื่นหรือทำอย่างอื่นต่อได้', 'info', null, 4000);
    let changed = 0;
    try {
      for (const s of withText) {
        const r = await this.api.invoke('video:caption-fix', { sourceId: s.id, hint });
        changed += r.changed;
      }
      this.notice(changed ? `JARVIS แก้คำให้ ${changed} ประโยค — กด ↺ ที่ประโยคเพื่อคืนค่าเดิมได้` : 'JARVIS ไม่พบคำที่ต้องแก้', 'info', null, 6000);
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
    }
  }

  _renderTranscript() {
    const words = [];
    for (const s of this.snap.sources) {
      const segs = s.analysis && s.analysis.transcript ? s.analysis.transcript.segments : [];
      for (const g of mapRanges(this.snap.clips, s.id, segs)) words.push({ ...g, srcId: s.id });
    }
    words.sort((a, b) => a.start - b.start);
    const list = $('ve-transcript');
    $('ve-fix').disabled = !!this.snap.fix || !words.length;
    $('ve-fix').textContent = this.snap.fix ? 'JARVIS กำลังตรวจคำ…' : '✨ ให้ JARVIS ตรวจคำ';
    list.replaceChildren(...(words.length ? words.map((w) => this._transcriptLine(w)) : [el('li', { class: 'dim', text: this.progress.running ? 'กำลังถอดเสียงพูด…' : 'ยังไม่มีคำพูดที่ถอดได้' })]));
  }

  _transcriptLine(w) {
    const e = this.editing;
    if (e && e.srcId === w.srcId && e.i === w.i) {
      const input = el('input', { class: 've-line-input', type: 'text', maxlength: '300', value: w.text, 'aria-label': 'แก้ข้อความซับ' });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); this.finishCaptionEdit(true, input.value); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.finishCaptionEdit(false); }
        else ev.stopPropagation(); // typing must not trigger the editor's keys (S, Delete, space…)
      });
      return el('li', { class: 've-line-edit' }, input,
        el('div', { class: 've-actions' },
          el('button', { class: 'btn small', type: 'button', text: 'บันทึก', onclick: () => this.finishCaptionEdit(true, input.value) }),
          el('button', { class: 'btn small', type: 'button', text: 'ยกเลิก', onclick: () => this.finishCaptionEdit(false) })));
    }
    return el('li', { class: w.edited ? 've-line-row edited' : 've-line-row' },
      el('button', { class: 've-line', type: 'button', title: 'ไปที่ประโยคนี้', onclick: () => { this.pause(); this.seek(w.start); } },
        el('span', { class: 'mono dim', text: fmtTime(w.start) }), el('span', { text: w.text })),
      el('span', { class: 've-line-tools' },
        w.edited ? el('button', { class: 've-mini', type: 'button', title: `คืนค่าเดิม: ${w.orig}`, 'aria-label': 'คืนค่าเดิม', text: '↺', onclick: () => this.captionCall('video:caption-restore', { sourceId: w.srcId, i: w.i }) }) : null,
        el('button', { class: 've-mini', type: 'button', title: 'แก้คำ', 'aria-label': 'แก้ข้อความซับ', text: '✎', onclick: () => this.startCaptionEdit(w.srcId, w.i) })));
  }

  // ---------- editing (mouse, keys and voice all end up in edit()) ----------
  async edit(op) {
    try {
      this.setState(await this.api.invoke('video:edit', op));
      return true;
    } catch (err) {
      this.notice(String(err.message || err).replace(/^.*Error: /, ''), 'warn');
      return false;
    }
  }

  /** The selected clip, or else the one under the playhead. */
  _target() {
    const clips = this.snap.clips;
    const picked = clips.find((c) => c.id === this.sel);
    if (picked) return picked;
    const loc = clips.length ? locate(clips, this.t) : null;
    return loc ? loc.clip : null;
  }

  select(id) {
    this.sel = id;
    this._renderTimeline();
    this._renderTools();
  }

  split() {
    if (!this.snap.clips.length) return Promise.resolve(false);
    this.pause();
    return this.edit({ op: 'split', at: this.t });
  }

  async removeClip() {
    const c = this._target();
    if (!c) return false;
    this.pause();
    this.sel = null;
    return this.edit({ op: 'remove', id: c.id });
  }

  /** How the selected clip comes in: { fx } and/or { sfx }. */
  async setClipFx(change) {
    const c = this._target();
    if (!c) return false;
    return this.edit({ op: 'fx', id: c.id, ...change });
  }

  async setClipSpeed(speed) {
    const c = this._target();
    if (!c) return false;
    return this.edit({ op: 'speed', id: c.id, speed });
  }

  /** Voice / key helper: one step faster or slower than the clip's speed now. */
  async nudgeSpeed(dir) {
    const c = this._target();
    if (!c) return false;
    const next = dir > 0 ? SPEEDS.find((x) => x > c.speed + 1e-9) : [...SPEEDS].reverse().find((x) => x < c.speed - 1e-9);
    if (next === undefined) {
      this.notice(dir > 0 ? 'เร็วสุดแล้ว (3×)' : 'ช้าสุดแล้ว (0.5×)', 'info', null, 3000);
      return false;
    }
    return this.setClipSpeed(next);
  }

  /** Voice commands from handsfree/commands.js (action 'edit'). */
  voice(cmd) {
    if (!this.snap.sources.length) return this.notice('ยังไม่มีคลิปในหน้าตัดต่อ', 'warn');
    const op = typeof cmd === 'string' ? cmd : cmd.op;
    switch (op) {
      case 'overlay-add': return this.addOverlayByVoice(cmd.overlay);
      case 'overlay-remove': return this.removeOverlayByVoice(cmd.all);
      case 'fx': return cmd.all ? this.edit({ op: 'fx-all', ...cmd.change }) : this.setClipFx(cmd.change);
      case 'split': return this.split();
      case 'delete': return this.removeClip();
      case 'faster': return this.nudgeSpeed(1);
      case 'slower': return this.nudgeSpeed(-1);
      case 'normal': return this.setClipSpeed(1);
      case 'undo': return this.snap.canUndo ? this.undo() : this.notice('ไม่มีอะไรให้ย้อนกลับ', 'info', null, 3000);
      case 'redo': return this.snap.canRedo ? this.redo() : this.notice('ไม่มีอะไรให้ทำซ้ำ', 'info', null, 3000);
      case 'play': return this.play();
      case 'pause': return this.pause();
      case 'start': return this.seek(0);
      default: return null;
    }
  }

  _renderTools() {
    const has = this.snap.clips.length > 0 && !(this.cutState && this.cutState.running);
    const c = this._target();
    $('ve-split').disabled = !has;
    $('ve-delete').disabled = !has || !c;
    const sp = $('ve-speed');
    sp.disabled = !has || !c;
    if (c) {
      if (![...sp.options].some((o) => Number(o.value) === c.speed)) sp.append(el('option', { value: String(c.speed), text: `${c.speed}×` }));
      sp.value = String(c.speed);
    }
    const fxSel = $('ve-fx');
    const sfxSel = $('ve-sfx');
    fxSel.disabled = sfxSel.disabled = $('ve-fxout').disabled = !has || !c;
    $('ve-fx-all').disabled = !has || this.snap.clips.length < 2;
    if (c) {
      fxSel.value = c.fx || 'none';
      sfxSel.value = c.sfx || 'none';
      $('ve-fxout').value = c.fxOut || 'none';
    }
    const i = c ? this.snap.clips.findIndex((x) => x.id === c.id) : -1;
    $('ve-sel-hint').textContent = c ? `${this.sel === c.id ? 'เลือก' : 'ใต้หัวอ่าน'}: ช่วงที่ ${i + 1}/${this.snap.clips.length}` : '';
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
    $('ve-fix').onclick = (e) => e.isTrusted && this.fixCaptions();
    $('ve-render').onclick = (e) => e.isTrusted && this.startRender();
    $('ve-export').onclick = (e) => e.isTrusted && this.startExport();
    $('ve-preset').onchange = () => this._renderExportNote();
    $('ve-split').onclick = () => this.split();
    $('ve-delete').onclick = () => this.removeClip();
    $('ve-speed').onchange = (e) => this.setClipSpeed(Number(e.target.value));
    $('ve-fx').onchange = (e) => this.setClipFx({ fx: e.target.value });
    $('ve-sfx').onchange = (e) => this.setClipFx({ sfx: e.target.value });
    $('ve-fxout').onchange = (e) => this.setClipFx({ fxOut: e.target.value });
    $('ve-ov-kind').onchange = () => this._ovFields();
    $('ve-emoji-add').onclick = (e) => e.isTrusted && this.addEmoji(false);
    $('ve-emoji-auto').onclick = (e) => e.isTrusted && this.addEmoji(true);
    $('ve-emoji-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.addEmoji(false); } else e.stopPropagation(); });
    $('ve-sfx-find').onclick = (e) => e.isTrusted && this.findSounds(false);
    $('ve-sfx-auto').onclick = (e) => e.isTrusted && this.findSounds(true);
    $('ve-sfx-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.findSounds(false); } else e.stopPropagation(); });
    $('ve-cap-style').onchange = () => { this.fx.key = ''; this._paintFx(); };
    $('ve-ov-save').onclick = () => this.saveOverlay();
    $('ve-ov-cancel').onclick = () => this._ovReset();
    $('ve-fx-all').onclick = () => this.edit({ op: 'fx-all', fx: $('ve-fx').value, sfx: $('ve-sfx').value, fxOut: $('ve-fxout').value });
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
      if (e.button !== 0 || !this.snap.clips.length || e.target.closest('.ve-clip, .ve-anim, .ve-say.drag')) return;
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
      KeyS: () => this.split(),
      Delete: () => this.removeClip(),
      Backspace: () => this.removeClip(),
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
    if (this.sel && !s.clips.some((c) => c.id === this.sel)) this.sel = null;
    // the snapshot carries the cut too, so a reopened page shows a running or finished cut
    if (s.cut) this.cutState = { running: true, ...s.cut };
    else if (!this.cutState || !this.cutState.running) this.cutState = s.lastCut ? { running: false, result: s.lastCut } : null;
    if (s.sfx) this.sfxState = { running: true, ...s.sfx };
    else if (!this.sfxState || !this.sfxState.running) this.sfxState = s.lastSfx ? { running: false, result: s.lastSfx } : null;
    const imagesKey = JSON.stringify(s.images || []);
    if (imagesKey !== this._imagesKey) {
      this._imagesKey = imagesKey;
      this._loadImages();
    }
    const soundsKey = JSON.stringify(s.sounds || []);
    if (soundsKey !== this._soundsKey) {
      this._soundsKey = soundsKey;
      this._loadSounds();
    }
    if (s.render) this.renderState = { running: true, ...s.render };
    else if (!this.renderState || !this.renderState.running) this.renderState = s.lastRender ? { running: false, result: s.lastRender } : null;
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
    this._fireCues(this.t - 0.001, this.t + 0.001); // a sound exactly at the playhead
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
    this._stopSfx();
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
    const prev = this.t;
    this.t = timelineTime(clips, this.index, st);
    this._fireCues(prev, this.t);
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
    this._fireCues(this.t, next.start);
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
    $('ve-undo').disabled = !this.snap.canUndo;
    $('ve-redo').disabled = !this.snap.canRedo;
    this._renderCut();
    this._renderRender();
    this._renderExportNote();
    this._renderOverlays();
    this._renderSfx();
    this._renderEmoji();
    this._buildCues();
    this._renderTools();
    if (!has) return;
    this._renderPreviewShape();
    this.fx.measure();
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
    if (!this.editing) this._renderTranscript(); // never rebuild the list under a line being typed
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
      const b = el('div', { class: `ve-clip ve-c${(Number(String(r.clip.src).slice(1)) || 0) % 4}${r.clip.id === this.sel ? ' sel' : ''}`, title: `${src ? src.name : ''} · ${fmtTime(r.end - r.start)} — ลากเพื่อย้าย · ลากขอบเพื่อตัดหัว/ท้าย` },
        el('span', { class: 've-grip ve-grip-l', 'data-edge': 'in' }),
        el('span', { class: 've-clip-name', text: src ? src.name : r.clip.src }),
        r.clip.speed !== 1 ? el('span', { class: 've-clip-speed mono', text: `${r.clip.speed}×` }) : null,
        r.clip.fx && r.clip.fx !== 'none' ? el('span', { class: 've-clip-fx', title: `เอฟเฟกต์ตอนเข้า: ${(this.fxLabels || {})[r.clip.fx] || r.clip.fx}`, text: '✨' }) : null,
        r.clip.fxOut && r.clip.fxOut !== 'none' ? el('span', { class: 've-clip-fx', title: `เอฟเฟกต์ตอนออก: ${(this.fxOutLabels || {})[r.clip.fxOut] || r.clip.fxOut}`, text: '🌗' }) : null,
        r.clip.sfx && r.clip.sfx !== 'none' ? el('span', { class: 've-clip-fx', title: `เสียง: ${(this.sfxLabels || {})[r.clip.sfx] || r.clip.sfx}`, text: '🔊' }) : null,
        el('span', { class: 've-grip ve-grip-r', 'data-edge': 'out' }));
      b.style.cssText = `left:${px(r.start)};width:${px(r.end - r.start)}`;
      b.addEventListener('pointerdown', (e) => this._clipDown(e, r, b, src));
      return b;
    }));

    const silences = [];
    const speech = [];
    for (const s of this.snap.sources) {
      if (!s.analysis) continue;
      silences.push(...mapRanges(this.snap.clips, s.id, s.analysis.silences));
      if (s.analysis.transcript) speech.push(...mapRanges(this.snap.clips, s.id, s.analysis.transcript.segments).map((g) => ({ ...g, srcId: s.id })));
    }
    $('ve-lane-silence').replaceChildren(...silences.map((g) => {
      const b = el('div', { class: 've-sil', title: `เงียบ ${fmtTime(g.end - g.start)}` });
      b.style.cssText = `left:${px(g.start)};width:${px(g.end - g.start)}`;
      return b;
    }));
    $('ve-lane-speech').replaceChildren(...speech.map((g) => {
      // a line that lies wholly inside one clip can be dragged; one cut across clips cannot (which edge?)
      const src = this._source(g.srcId);
      const seg = src && src.analysis.transcript.segments[g.i];
      const loc = locate(this.snap.clips, (g.start + g.end) / 2);
      const clip = loc && loc.clip;
      const drag = !!(seg && clip && clip.src === g.srcId && seg.start >= clip.in - 1e-6 && seg.end <= clip.out + 1e-6);
      const b = el('div', { class: drag ? 've-say drag' : 've-say', title: drag ? `${g.text} — ลากขอบเพื่อปรับเวลาซับ ลากกลางเพื่อเลื่อน` : g.text },
        drag ? el('span', { class: 've-grip ve-grip-l', 'data-edge': 'in' }) : null,
        el('span', { class: 've-say-text', text: g.text }),
        drag ? el('span', { class: 've-grip ve-grip-r', 'data-edge': 'out' }) : null);
      b.style.cssText = `left:${px(g.start)};width:${px(g.end - g.start)}`;
      if (drag) b.addEventListener('pointerdown', (e) => this._sayDown(e, g, seg, clip, b));
      return b;
    }));
    $('ve-lane-anim').replaceChildren(...(this.snap.overlays || []).filter((o) => o.start < duration).map((o) => {
      const b = el('div', { class: o.id === this.ovEditing ? 've-anim on' : 've-anim', title: `${OV_NAMES[o.kind] || o.kind}: ${o.text} — กดเพื่อแก้` }, el('span', { text: o.text || OV_NAMES[o.kind] }));
      b.style.cssText = `left:${px(o.start)};width:${px(Math.min(o.end, duration) - o.start)}`;
      b.addEventListener('click', () => { this.loadOverlay(o); this.pause(); this.seek(o.start); });
      return b;
    }));
    for (const [k, label] of Object.entries(LANE_LABELS)) $(`ve-label-${k}`).textContent = label;
  }

  /** Press on a subtitle block: drag an edge to retime it, drag the middle to move it, click to go there. */
  _sayDown(e, g, seg, clip, b) {
    if (e.button !== 0) return;
    e.preventDefault();
    const edge = e.target.dataset && e.target.dataset.edge;
    const segs = this._source(g.srcId).analysis.transcript.segments;
    const prev = segs[g.i - 1];
    const next = segs[g.i + 1];
    const lo = Math.max(clip.in, prev ? prev.end : 0);
    const hi = Math.min(clip.out, next ? next.start : Infinity);
    const MIN = 0.2;
    const x0 = e.clientX;
    const pps = this.pxPerSec;
    const px = (t) => `${(t * pps).toFixed(1)}px`;
    const clamp = (x, a, z) => Math.max(a, Math.min(z, x));
    this.pause();
    try { b.setPointerCapture(e.pointerId); } catch { /* the block was redrawn under the pointer */ }
    let moved = false;
    let res = null;
    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_PX) return;
      moved = true;
      const d = (dx / pps) * clip.speed; // source seconds
      let a = seg.start;
      let z = seg.end;
      if (edge === 'in') a = clamp(seg.start + d, lo, seg.end - MIN);
      else if (edge === 'out') z = clamp(seg.end + d, seg.start + MIN, hi);
      else {
        const len = seg.end - seg.start;
        a = clamp(seg.start + d, lo, hi - len);
        z = a + len;
      }
      res = { start: a, end: z };
      b.style.left = px(g.start + (a - seg.start) / clip.speed);
      b.style.width = px((z - a) / clip.speed);
    };
    const done = async (ev) => {
      b.removeEventListener('pointermove', onMove);
      b.removeEventListener('pointerup', done);
      b.removeEventListener('pointercancel', done);
      try { b.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      if (!moved) {
        const r = $('ve-track').getBoundingClientRect();
        this.seek((ev.clientX - r.left) / pps);
        return;
      }
      const ok = res && (res.start !== seg.start || res.end !== seg.end)
        ? await this.captionCall('video:caption-time', { sourceId: g.srcId, i: g.i, start: res.start, end: res.end })
        : false;
      if (!ok) this._renderTimeline(); // put the block back
    };
    b.addEventListener('pointermove', onMove);
    b.addEventListener('pointerup', done);
    b.addEventListener('pointercancel', done);
  }

  /** Press on a clip: click selects, dragging the body moves it, dragging an edge trims it. */
  _clipDown(e, row, b, src) {
    if (e.button !== 0) return;
    e.preventDefault();
    const clip = row.clip;
    const edge = e.target.dataset && e.target.dataset.edge;
    const x0 = e.clientX;
    const pps = this.pxPerSec;
    const len = row.end - row.start;
    const wasPlaying = this.playing;
    this.pause();
    try { b.setPointerCapture(e.pointerId); } catch { /* the block was redrawn under the pointer */ }
    let moved = false;
    let result = null; // { in, out } for a trim, { to } for a move

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_PX) return;
      moved = true;
      const dsec = dx / pps; // timeline seconds
      if (edge) {
        const top = src && Number.isFinite(src.duration) ? src.duration : Infinity;
        let from = clip.in;
        let out = clip.out;
        if (edge === 'in') from = Math.max(0, Math.min(clip.out - MIN_CLIP, clip.in + dsec * clip.speed));
        else out = Math.min(top, Math.max(clip.in + MIN_CLIP, clip.out + dsec * clip.speed));
        result = { in: from, out };
        const left = row.start + (from - clip.in) / clip.speed;
        b.style.left = `${(left * pps).toFixed(1)}px`;
        b.style.width = `${(((out - from) / clip.speed) * pps).toFixed(1)}px`;
      } else {
        b.classList.add('dragging');
        const shift = Math.max(-row.start, Math.min(this.snap.duration - row.end, dsec));
        b.style.transform = `translateX(${(shift * pps).toFixed(1)}px)`;
        const mid = row.start + len / 2 + shift;
        result = { to: layout(this.snap.clips).filter((o) => o.clip.id !== clip.id && (o.start + o.end) / 2 <= mid + 1e-6).length };
      }
    };
    const done = async (ev) => {
      b.removeEventListener('pointermove', onMove);
      b.removeEventListener('pointerup', done);
      b.removeEventListener('pointercancel', done);
      try { b.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      b.classList.remove('dragging');
      b.style.transform = '';
      if (!moved) {
        // a plain click: select the clip and put the playhead where it was clicked
        this.select(clip.id);
        const r = $('ve-track').getBoundingClientRect();
        await this.seek(Math.max(row.start, Math.min(row.end - 0.001, (ev.clientX - r.left) / pps)));
        if (wasPlaying) this.play();
        return;
      }
      this.sel = clip.id;
      let ok = false;
      if (result && edge) ok = (result.in === clip.in && result.out === clip.out) || (await this.edit({ op: 'trim', id: clip.id, in: result.in, out: result.out }));
      else if (result) ok = result.to === row.index || (await this.edit({ op: 'move', id: clip.id, to: result.to }));
      if (!ok) this._renderTimeline(); // put the clip back where it was
      this._renderTools();
    };
    b.addEventListener('pointermove', onMove);
    b.addEventListener('pointerup', done);
    b.addEventListener('pointercancel', done);
  }

  /** The live look of effects, animations and subtitles at the playhead (see ui/video-preview.js). */
  _paintFx() {
    if (!this.snap.clips.length) return this.fx.clear();
    this.fx.build(this.snap.overlays || [], $('ve-cap-style').value, this.stickers || {}, Object.fromEntries((this.images || []).filter((x) => x.url).map((x) => [x.id, x.url])));
    this.fx.paint(this.t, { rows: layout(this.snap.clips), captions: this.snap.captions || [] });
  }

  _renderTime() {
    this._paintFx();
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
