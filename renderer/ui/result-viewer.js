// Result Viewer: shows the assistant's jarvis-result payloads as tabs of the
// shared large viewer (ui/stage-viewer.js — the same viewer and transition as
// Camera mode).
//   • a WebSearch starts → the viewer opens at once with a skeleton ("กำลังค้นหา…")
//   • the jarvis-result block arrives → the skeleton tab becomes the result
//   • the turn ends without one → skeleton removed, or a long answer becomes a text tab
// Also: open pages / videos from results in new tabs, video state (duck TTS +
// sounds, "▶ PLAYING" on the reactor), voice operations and "ดูผลลัพธ์อีกครั้ง".

import { renderResult, renderSkeleton, renderEmpty, TYPE_META, youtubeId, safeUrl, domainOf } from './results.js';

const LONG_ANSWER = 700; // characters: a reply this long without a payload opens as a text tab

export class ResultViewer {
  /**
   * o: { viewer, home, api, speaker, sfx, web: WebViewer, retry(): void }
   */
  constructor(o) {
    this.o = o;
    this.viewer = o.viewer;
    this.turn = null; // { skeletonId, hadResult }
    this.last = null; // last payload shown (for "ดูผลลัพธ์อีกครั้ง")
    this.lastAt = 0;
    this.playing = new Set(); // tab ids whose video is playing
    this.attention = false; // JARVIS listening / speaking → videos duck
    this.sel = -1;
    this.viewer.onChange((ev, tab) => this._onViewer(ev, tab));
  }

  get isOpen() {
    return this.viewer.isOpen;
  }

  /** Voice-command context for the parser. */
  context() {
    const t = this.viewer.current;
    return { viewer: this.viewer.isOpen, video: !!(t && t.ctl && t.ctl.video), web: !!(this.o.web && this.o.web.current) };
  }

  // ---------- turn lifecycle (from app.js) ----------
  startTurn() {
    this.turn = { skeletonId: null, hadResult: false };
  }

  /** A web search started: open the viewer with a skeleton right away. */
  searchStarted(query) {
    if (!this.turn) this.startTurn();
    if (this.turn.skeletonId || this.turn.hadResult) return;
    if (this._deferred()) return; // the conversation is open: no skeleton over it
    const q = String(query || '').slice(0, 120);
    this.turn.skeletonId = this.viewer.open({
      kind: 'result',
      icon: 'search',
      title: q ? `กำลังค้นหา: ${q}` : 'กำลังค้นหา…',
      meta: '',
      mount: (body) => renderSkeleton(body, 'search'),
      external: () => null,
    });
    this.o.home.cards.setReplyReopen(null);
  }

  /** A jarvis-result payload arrived. */
  show(data) {
    if (!this.turn) this.startTurn();
    this.turn.hadResult = true;
    this.last = data;
    const id = this.turn.skeletonId;
    this.turn.skeletonId = null;
    if (this._deferred()) {
      // the conversation popup is in front: the app opens the result and adds a "เปิดดู" card in the chat
      if (id && this.viewer.tabs.has(id)) this.viewer.close(id);
      this.o.onDeferred(data, () => this._openPayload(data, null));
      return;
    }
    this._openPayload(data, id);
  }

  /** Results are held back (shown as a card in the conversation) instead of opening the viewer. */
  _deferred() {
    return !!(this.o.defer && this.o.defer() && this.o.onDeferred);
  }

  /** The turn ended. */
  endTurn(replyText) {
    const t = this.turn;
    this.turn = null;
    if (!t || t.hadResult) return;
    // the conversation already shows the whole answer: no text tab over it
    if (this._deferred()) {
      if (t.skeletonId) this.viewer.close(t.skeletonId);
      return;
    }
    const text = String(replyText || '').trim();
    if (text.length >= LONG_ANSWER) {
      const data = { type: 'text', title: 'คำตอบ', markdown: text };
      this.last = data;
      this._openPayload(data, t.skeletonId);
    } else if (t.skeletonId) {
      this.viewer.close(t.skeletonId); // searched, but nothing to show: back to the HUD
    }
  }

  /** Show a payload made by the app itself (test output, diff), outside any Claude turn. */
  display(data) {
    this.last = data;
    if (this._deferred()) {
      this.o.onDeferred(data, () => this._openPayload(data, null));
      return;
    }
    this._openPayload(data, null);
  }

  reopenLast() {
    if (this.last) this._openPayload(this.last, null);
  }

  // ---------- tabs ----------
  _openPayload(data, replaceId) {
    if (data.type === 'web' && this.o.web) {
      // live page + AI summary (Web Viewer); the search skeleton, if any, goes away
      const url = safeUrl(data.url || (data.items && data.items[0] && data.items[0].url));
      if (url) {
        if (replaceId && this.viewer.tabs.has(replaceId)) this.viewer.close(replaceId);
        this.o.web.open(url, { initiator: 'jarvis', question: data.question || '', title: data.title || '', speak: !data.spokenSummary });
        return null;
      }
    }
    this.lastAt = Date.now();
    const meta = TYPE_META[data.type] || TYPE_META.text;
    const items = data.items || [];
    const title = data.title && !data.title.startsWith(meta.label) ? `${meta.label}: ${data.title}` : data.title || meta.label;
    const n = items.length;
    const time = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const sources = (data.type === 'search' || data.type === 'news') && n ? `SOURCES · ${new Set(items.map((i) => domainOf(i.url) || i.source).filter(Boolean)).size || n}` : '';
    const spec = {
      kind: 'result',
      icon: meta.icon,
      title,
      meta: n && data.type !== 'youtube' ? `${n} รายการ · ${time}` : time,
      footer: data.spokenSummary || sources ? { text: data.spokenSummary || '', sources } : null,
      external: () => this._external(data),
      mount: (body, tab) => {
        this.sel = -1;
        return renderResult(body, data, this._ctx(tab));
      },
    };
    if (replaceId && this.viewer.tabs.has(replaceId)) {
      this.viewer.update(replaceId, spec);
      this.viewer.select(replaceId);
      return replaceId;
    }
    return this.viewer.open(spec);
  }

  _external(data) {
    const t = this.viewer.current;
    if (t && t.ctl && t.ctl.external) return t.ctl.external();
    const sel = t && t.ctl && t.ctl.items && t.ctl.items[this.sel];
    if (sel && sel.url) return sel.url;
    return safeUrl(data.url) || (data.items && data.items[0] && safeUrl(data.items[0].url)) || null;
  }

  /** Open a link from a result inside the viewer (YouTube links become a video tab). */
  openWeb(url, title) {
    const u = safeUrl(url);
    if (!u) return;
    const vid = youtubeId(u);
    if (vid) {
      this._openPayload({ type: 'youtube', title: title || 'YouTube', items: [{ videoId: vid, title: title || '' }] }, null);
      return;
    }
    if (this.o.web) this.o.web.open(u, { initiator: 'jarvis', title: title || '' });
    else this._openPayload({ type: 'web', title: title || domainOf(u), url: u }, null);
  }

  openExternal(url) {
    const u = safeUrl(url);
    if (u) this.o.api.invoke('web:open-external', u).catch(() => {});
  }

  _ctx(tab) {
    return {
      openWeb: (url, title) => this.openWeb(url, title),
      openExternal: (url) => this.openExternal(url),
      speak: (text) => this.speak(text),
      retry: () => this.o.retry(),
      reveal: (el) => this.viewer.reveal(el),
      onVideo: (state) => this._video(tab.id, state),
      revertFiles: this.o.revertFiles,
      openProjectDiff: this.o.openProjectDiff,
      reconnectMcp: this.o.reconnectMcp,
    };
  }

  speak(text) {
    const sp = this.o.speaker;
    if (!text || sp.engine === 'none') return;
    sp.enqueue(String(text).slice(0, 600));
    sp.flush();
  }

  // ---------- video: duck everything else, "▶ PLAYING" on the reactor ----------
  _video(tabId, state) {
    if (state === 'playing') this.playing.add(tabId);
    else this.playing.delete(tabId);
    const on = this.playing.size > 0;
    this.o.sfx.setDuck(on ? 0.5 : 1);
    this.o.speaker.setDuck(on ? 0.6 : 1);
    const tag = document.getElementById('core-play');
    if (tag) tag.hidden = !on;
    if (on) this._applyAttention();
  }

  /** JARVIS is listening or talking: videos drop to 20 % until it is done. */
  setAttention(on) {
    if (on === this.attention) return;
    this.attention = on;
    this._applyAttention();
  }

  _applyAttention() {
    for (const t of this.viewer.tabs.values()) if (t.ctl && t.ctl.video) t.ctl.video.duck(this.attention);
  }

  _onViewer(ev, tab) {
    if (ev === 'close' && tab) this._video(tab.id, 'none');
    if (ev === 'select') this.sel = -1;
    if (ev === 'closed') {
      // back on the HUD: LAST REPLY offers the last result (or web page) again
      if (this.o.web && this.o.web.lastAt > this.lastAt && this.o.web.offerReopen()) return;
      this.o.home.cards.setReplyReopen(this.last ? () => this.reopenLast() : null);
    }
    if (ev === 'opened') this.o.home.cards.setReplyReopen(null);
  }

  // ---------- voice operations ----------
  /** cmd from handsfree/commands.js: { action: 'viewer', op, n? } → true when handled */
  command(cmd) {
    const v = this.viewer;
    const t = v.current;
    const ctl = (t && t.ctl) || {};
    const items = ctl.items || [];
    const item = (n) => items[n - 1];
    if (cmd.op !== 'close' && cmd.op !== 'wide' && this.o.web && this.o.web.command(cmd)) return true;
    switch (cmd.op) {
      case 'close': v.closeAll(); return true;
      case 'wide': v.setWide(cmd.n === 1); return true;
      case 'next':
      case 'prev': {
        const d = cmd.op === 'next' ? 1 : -1;
        if (v.order.length > 1) v.select(d);
        else if (items.length) this._highlight(this.sel < 0 ? (d > 0 ? 0 : items.length - 1) : (this.sel + d + items.length) % items.length, items);
        return true;
      }
      case 'open': {
        const it = item(cmd.n);
        if (it) { this._highlight(cmd.n - 1, items); it.open(); } else this.speak(`ไม่มีรายการที่ ${cmd.n}`);
        return true;
      }
      case 'read': {
        const it = item(cmd.n);
        if (it) { this._highlight(cmd.n - 1, items); this.speak(it.read); } else this.speak(`ไม่มีรายการที่ ${cmd.n}`);
        return true;
      }
      case 'scroll':
        if (t) t.body.scrollBy({ top: cmd.n * t.body.clientHeight * 0.8, behavior: 'smooth' });
        return true;
      case 'external': {
        const url = this._external(this.last || {});
        if (url) this.openExternal(url);
        return true;
      }
      case 'play': if (ctl.video) ctl.video.play(); return true;
      case 'pause': if (ctl.video) ctl.video.pause(); return true;
      case 'seek': if (ctl.video) ctl.video.seek(cmd.n); return true;
      case 'volume': if (ctl.video) ctl.video.volume(cmd.n); return true;
      default: return false;
    }
  }

  _highlight(i, items) {
    if (this.sel >= 0 && items[this.sel]) items[this.sel].el.classList.remove('sel');
    this.sel = i;
    const it = items[i];
    if (!it) return;
    it.el.classList.add('sel');
    it.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Error state for the pending skeleton (e.g. the turn failed). */
  fail(msg) {
    const t = this.turn;
    if (!t || !t.skeletonId) return;
    this.viewer.update(t.skeletonId, { title: 'โหลดไม่สำเร็จ', mount: (body) => renderEmpty(body, msg || 'โหลดไม่สำเร็จ', () => this.o.retry()) });
    t.skeletonId = null;
  }
}
