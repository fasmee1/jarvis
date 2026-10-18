'use strict';
// Web Viewer page reader (main process): page → extracted content → summary.
//
//   did-stop-loading → inject the agent (isolated world) → wait for the DOM to
//   settle (800 ms quiet, ≤ 8 s) → extract → captcha / login wall? → summarize
//
// A newer navigation cancels older work (the summarizer process is killed).
// A blocked page keeps the notice up; once the user gets past it the next
// navigation is read automatically.

const fs = require('fs');
const path = require('path');
const { blockedSignals, readingMinutes } = require('./page-text');

let agentSource = null;
function agent() {
  if (!agentSource) {
    const read = (p) => fs.readFileSync(p, 'utf8');
    const readability = read(require.resolve('@mozilla/readability/Readability.js'));
    agentSource = [readability, read(path.join(__dirname, 'page-text.js')), read(path.join(__dirname, 'page-agent.js'))].join('\n;\n');
  }
  return agentSource;
}

const REF = /^p\d{1,6}$/;

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s).slice(0, 40);
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

class PageReader {
  /** o: { browser: WebBrowser, summarizer: Summarizer, send(channel, payload), pdf?: PdfReader, log?(msg) } */
  constructor(o) {
    this.o = o;
    this.b = o.browser;
    this.st = new Map(); // tabId → { ac, ex, question, nav }
    this.b.onSettled = (tab) => { this.read(tab, 'full').catch(() => {}); };
    this.b.onClosed = (id) => this.drop(id);
  }

  _s(id) {
    let s = this.st.get(id);
    if (!s) this.st.set(id, (s = { ac: null, ex: null, question: '' }));
    return s;
  }

  drop(id) {
    const s = this.st.get(id);
    if (s && s.ac) s.ac.abort();
    this.st.delete(id);
    if (this.o.pdf) this.o.pdf.drop(id);
  }

  /** The user's question for this page (answered first in the next summary). */
  setQuestion(id, q) {
    this._s(id).question = String(q || '').slice(0, 500);
  }

  _send(id, data) {
    this.o.send('web:summary', { tabId: id, ...data });
  }

  async _inject(tab) {
    const has = await this.b.run(tab.id, 'typeof window.__jv === "object" && window.__jv.v === 2');
    if (!has) await this.b.run(tab.id, `${agent()}\n;true`);
  }

  /** Extract the page (from the top, or what's after the scroll position). */
  async extract(tab, from = 'top') {
    const s = this._s(tab.id);
    s.pdf = !!(this.o.pdf && (await this.o.pdf.isPdf(tab)));
    if (s.pdf) return this.o.pdf.extract(tab);
    await this._inject(tab);
    await this.b.run(tab.id, 'window.__jv.settle(800, 8000)');
    const ex = await this.b.run(tab.id, `window.__jv.extract(${JSON.stringify({ from })})`);
    if (!ex || !Array.isArray(ex.passages)) throw new Error('อ่านหน้าเว็บไม่ได้');
    return ex;
  }

  source(ex, tab) {
    const text = ex.passages.map((p) => p.text).join(' ');
    let site = ex.siteName;
    if (!site) { try { site = new URL(ex.url).hostname.replace(/^www\./, ''); } catch { site = ''; } }
    return {
      siteName: site,
      title: ex.title || (tab && tab.st.title) || '',
      url: ex.canonical && /^https?:/i.test(ex.canonical) ? ex.canonical : ex.url,
      published: fmtDate(ex.published),
      author: ex.author || '',
      readingMin: readingMinutes(text),
      image: (ex.images || [])[0] || '',
    };
  }

  /**
   * Read + summarize a tab. mode 'full' (from the top) | 'continue' (after the
   * scroll position). Results go to the renderer as web:summary events.
   */
  async read(tab, mode = 'full', { force = false } = {}) {
    const s = this._s(tab.id);
    // a PDF jumping to #page=N reloads the viewer: same file, same summary
    const base = tab.wc.getURL().replace(/#.*$/, '');
    if (!force && mode === 'full' && !s.question && s.pdfReady && s.pdfReady.base === base) {
      this._send(tab.id, s.pdfReady.payload);
      return;
    }
    if (s.ac) s.ac.abort();
    const ac = new AbortController();
    s.ac = ac;
    const nav = tab.nav;
    const stale = () => ac.signal.aborted || tab.nav !== nav || !this.b.tab(tab.id);
    this._send(tab.id, { state: 'loading', mode });
    try {
      const ex = await this.extract(tab, mode === 'continue' ? 'scroll' : 'top');
      if (stale()) return;
      const source = this.source(ex, tab);
      const blocked = ex.blockSignals ? blockedSignals({ ...ex.blockSignals, status: tab.st.status }) : { blocked: false };
      if (blocked.blocked && mode === 'full') {
        s.ex = null;
        this._send(tab.id, { state: 'blocked', kind: blocked.kind, source });
        return;
      }
      if (!ex.passages.length && !ex.description) {
        this._send(tab.id, { state: 'failed', error: 'ไม่พบเนื้อหาที่อ่านได้ในหน้านี้', source });
        return;
      }
      s.ex = ex;
      if (!ex.passages.length) ex.passages = [{ id: 'p0', tag: 'p', text: ex.description, section: '' }];
      const question = mode === 'full' ? s.question : '';
      const r = await this.o.summarizer.summarize(ex, { question, signal: ac.signal });
      if (stale()) return;
      if (question) s.question = '';
      const tall = ex.scroll && ex.scroll.h > ex.scroll.view * 2.5;
      const payload = {
        state: 'ready',
        mode,
        source,
        tldr: r.tldr,
        translatedFrom: r.translatedFrom,
        keyPoints: r.keyPoints,
        keyData: r.keyData,
        tables: (ex.tables || []).slice(0, 3).map((t) => ({ caption: t.caption, columns: t.columns, rows: t.rows })),
        answer: r.answer ? { question, ...r.answer } : null,
        injection: r.injection,
        more: r.more || (mode === 'full' && !!tall),
      };
      s.pdfReady = s.pdf && mode === 'full' ? { base, payload } : null;
      this._send(tab.id, payload);
    } catch (err) {
      if (stale() || (err && err.name === 'AbortError')) return;
      this._log(`read ${tab.id}: ${err && err.message}`);
      this._send(tab.id, { state: 'failed', error: friendly(err) });
    }
  }

  /** "ถามหน้านี้" → { ok, text, refs, found } */
  async ask(id, question) {
    const tab = this.b.tab(id);
    if (!tab) return { ok: false, error: 'ไม่พบแท็บ' };
    const s = this._s(id);
    try {
      let ex = s.ex;
      if (!ex || ex.url !== tab.wc.getURL()) ex = s.ex = await this.extract(tab, 'top');
      const r = await this.o.summarizer.ask(ex, question);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  }

  async highlight(id, ref) {
    const tab = this.b.tab(id);
    if (!tab || !REF.test(String(ref))) return false;
    if (this._s(id).pdf) return this.o.pdf.highlight(tab, ref);
    await this._inject(tab);
    return !!(await this.b.run(tab.id, `window.__jv.highlight(${JSON.stringify(ref)})`));
  }

  async scroll(id, dir) {
    const tab = this.b.tab(id);
    if (!tab) return false;
    await this._inject(tab);
    return !!(await this.b.run(tab.id, `window.__jv.scroll(${JSON.stringify(dir)})`));
  }

  /**
   * "คลิกลิงก์ <text>": links are followed (navigation only). A button or form
   * control is reported back and clicked only with confirmed = true (the user
   * confirmed it on screen).
   */
  async clickLink(id, text, confirmed = false) {
    const tab = this.b.tab(id);
    if (!tab) return { ok: false, error: 'ไม่พบแท็บ' };
    await this._inject(tab);
    const r = await this.b.run(tab.id, `window.__jv.findLink(${JSON.stringify(String(text).slice(0, 200))})`);
    if (r && r.kind === 'link' && /^https?:\/\//i.test(r.href)) {
      tab.st.jarvis = true;
      tab.wc.loadURL(r.href).catch(() => {});
      return { ok: true, kind: 'link', label: r.label };
    }
    if (r && r.kind === 'button' && REF.test(r.ref)) {
      if (!confirmed) return { ok: false, kind: 'button', label: r.label };
      await this.b.run(tab.id, `window.__jv.clickButton(${JSON.stringify(r.ref)})`, { userGesture: true });
      return { ok: true, kind: 'button', label: r.label };
    }
    return { ok: false, kind: 'none', error: `ไม่พบลิงก์ “${String(text).slice(0, 60)}” ในหน้านี้` };
  }

  _log(m) {
    if (this.o.log) this.o.log(m);
  }
}

function friendly(err) {
  const m = String((err && err.message) || err || '');
  if (/CLAUDE_NOT_FOUND|ไม่พบคำสั่ง claude/i.test(m) || (err && err.code === 'CLAUDE_NOT_FOUND')) return 'ไม่พบ Claude Code ในเครื่อง';
  if (/Script failed to execute|Object has been destroyed|ERR_ABORTED/i.test(m)) return 'อ่านหน้าเว็บไม่ได้';
  return m.slice(0, 200) || 'สรุปไม่ได้';
}

module.exports = { PageReader, fmtDate };
