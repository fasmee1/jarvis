'use strict';
// PDFs in the Web Viewer: Chromium's built-in viewer shows the file; the text
// for the summary comes from pdf.js in main (the file is fetched again with the
// page's own session, so logins / cookies apply). Plain text only.

const { pathToFileURL } = require('url');

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 200;
const PARA = 900; // chars per passage (split at sentence ends)

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href).then((m) => {
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
      return m;
    });
  }
  return pdfjsP;
}

/** "D:20240131120000+07'00'" → ISO date, else ''. */
function pdfDate(s) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2] || '01'}-${m[3] || '01'}` : '';
}

/** Page text → passages of ≤ PARA chars, split at paragraph / sentence ends. */
function splitPage(text) {
  const out = [];
  for (const para of String(text).split(/\n\s*\n/)) {
    let rest = para.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    while (rest.length > PARA) {
      const cut = Math.max(rest.lastIndexOf('. ', PARA), rest.lastIndexOf(' ', PARA), PARA / 2);
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest.length >= 3) out.push(rest);
  }
  return out;
}

class PdfReader {
  /** o: { browser: WebBrowser } */
  constructor(o) {
    this.b = o.browser;
    this.pages = new Map(); // tabId → Map(ref → page number)
  }

  async isPdf(tab) {
    const url = tab.wc.getURL();
    const ct = await this.b.run(tab.id, 'document.contentType').catch(() => '');
    return ct === 'application/pdf' || (/\.pdf(?:$|[?#])/i.test(url) && ct !== 'text/html');
  }

  async extract(tab) {
    const url = tab.wc.getURL().replace(/#.*$/, '');
    const res = await this.b.session.fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`โหลด PDF ไม่สำเร็จ (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('ไฟล์ PDF ใหญ่เกินไป');
    const lib = await pdfjs();
    const task = lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const info = ((await doc.getMetadata().catch(() => null)) || {}).info || {};
    const passages = [];
    const refs = new Map();
    let n = 0;
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
      for (const t of splitPage(text)) {
        const id = `p${++n}`;
        refs.set(id, i);
        passages.push({ id, tag: 'p', text: t, section: `หน้า ${i}` });
      }
      page.cleanup();
    }
    const numPages = doc.numPages;
    await task.destroy();
    this.pages.set(tab.id, refs);
    const file = decodeURIComponent(url.split('/').pop() || 'PDF');
    let site = '';
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* none */ }
    return {
      url,
      title: String(info.Title || file).slice(0, 300),
      description: String(info.Subject || '').slice(0, 600),
      siteName: site,
      canonical: '',
      lang: '',
      author: String(info.Author || '').slice(0, 120),
      published: pdfDate(info.CreationDate),
      mode: 'pdf',
      passages,
      headings: [],
      tables: [],
      facts: require('./page-text').findFacts(passages),
      images: [],
      contentChars: passages.reduce((s, p) => s + p.text.length, 0),
      scroll: { y: 0, h: 0, view: 1 },
      pages: numPages,
    };
  }

  /** Jump the built-in viewer to the page that holds `ref`. */
  async highlight(tab, ref) {
    const page = (this.pages.get(tab.id) || new Map()).get(ref);
    if (!page) return false;
    // same-document hash change: the viewer jumps without reloading the file
    const ok = await this.b.run(tab.id, `location.hash = 'page=${Number(page)}'; true`).catch(() => false);
    if (!ok) tab.wc.loadURL(`${tab.wc.getURL().replace(/#.*$/, '')}#page=${page}`).catch(() => {});
    return true;
  }

  drop(id) {
    this.pages.delete(id);
  }
}

module.exports = { PdfReader, splitPage, pdfDate };
