// Web Viewer page agent. Injected by main into OUR isolated world of a web page
// (executeJavaScriptInIsolatedWorld): it shares the DOM with the page but not the
// page's JavaScript, so neither can call the other. Needs Readability and
// window.__jvText (page-text.js) loaded first in the same world.
//
// window.__jv:
//   settle(quietMs, maxMs) → Promise: resolves once the DOM stops changing (SPAs)
//   extract({ from: 'top' | 'scroll' }) → plain JSON describing the page
//   highlight(ref) · scroll(dir) · findLink(text) · clickButton(ref) · pauseMedia()
// Nothing here acts on the page unless main asks; main only asks for scrolling,
// highlighting, link lookup, and (after an on-screen confirmation) one button click.
(function () {
  'use strict';
  if (window.__jv && window.__jv.v === 2) return;
  const T = window.__jvText;
  const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption,td,th,caption,summary';
  const CHROME = 'nav,footer,aside,[role=navigation],[role=contentinfo],[role=banner],[role=complementary],[aria-hidden=true],script,style,noscript,template,svg,button,select,textarea,dialog:not([open])';
  const MAX_PASSAGES = 1500;
  const nodes = new Map(); // ref → element (live DOM)
  let seq = 0;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => {
    const e = document.querySelector(sel);
    return e ? norm(e.getAttribute('content') || '') : '';
  };

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  const refs = new WeakMap(); // element → ref (stable across extractions)
  function refFor(el) {
    let k = refs.get(el);
    if (!k) {
      k = `p${++seq}`;
      refs.set(el, k);
      nodes.set(k, el);
    }
    return k;
  }

  // ---------- settle ----------
  function settle(quietMs = 800, maxMs = 8000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let timer = 0;
      let big = 0;
      const done = (why) => { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve({ ms: Date.now() - t0, why, mutations: big }); };
      const obs = new MutationObserver((list) => {
        // only content changes count (new elements / text), not attribute churn
        let major = false;
        for (const m of list) {
          if (m.type === 'characterData') major = true;
          else for (const n of m.addedNodes) if (n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim().length > 20)) { major = true; break; }
          if (major) break;
        }
        if (!major) return;
        big++;
        clearTimeout(timer);
        timer = setTimeout(() => done('quiet'), quietMs);
      });
      obs.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(() => done('quiet'), quietMs);
      const cap = setTimeout(() => done('max'), maxMs);
    });
  }

  // ---------- passages ----------
  function blockPassages() {
    const out = [];
    for (const el of document.querySelectorAll(BLOCK)) {
      if (out.length >= MAX_PASSAGES) break;
      if (el.closest(CHROME)) continue;
      const tag = el.tagName.toLowerCase();
      // a list item / cell that wraps paragraphs: the inner blocks are taken instead
      if ((tag === 'li' || tag === 'td' || tag === 'th' || tag === 'dd' || tag === 'blockquote') && el.querySelector('p,li,h1,h2,h3,h4,h5,h6,pre')) continue;
      const text = norm(el.innerText);
      if (!text) continue;
      const heading = /^h[1-6]$/.test(tag);
      if (!heading && text.length < 25 && !/^(td|th|dd|dt)$/.test(tag)) continue;
      if (!visible(el)) continue;
      out.push({ el, tag, text: text.slice(0, 2500), heading });
    }
    return out;
  }

  /** Sites built only from <div>s: group visible text by its nearest block-level element. */
  function divPassages() {
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode()) && out.length < MAX_PASSAGES) {
      if (n.textContent.trim().length < 2) continue;
      let el = n.parentElement;
      while (el && el !== document.body && /^(inline|contents)/.test(getComputedStyle(el).display)) el = el.parentElement;
      if (!el || el === document.body || seen.has(el) || el.closest(CHROME)) continue;
      seen.add(el);
      const text = norm(el.innerText);
      if (text.length < 25 || text.length > 3000 || !visible(el)) continue;
      out.push({ el, tag: el.tagName.toLowerCase(), text, heading: false });
    }
    return out;
  }

  function readability() {
    try {
      if (typeof Readability !== 'function') return null;
      const a = new Readability(document.cloneNode(true), { charThreshold: 400 }).parse();
      return a && a.textContent && a.textContent.length > 400 ? a : null;
    } catch {
      return null;
    }
  }

  function jsonLd() {
    const out = { author: '', published: '' };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      const list = Array.isArray(data) ? data : data && data['@graph'] ? data['@graph'] : [data];
      for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        if (!out.published && typeof d.datePublished === 'string') out.published = d.datePublished;
        if (!out.author && d.author) {
          const a = Array.isArray(d.author) ? d.author[0] : d.author;
          out.author = typeof a === 'string' ? a : a && typeof a.name === 'string' ? a.name : '';
        }
      }
    }
    return out;
  }

  function tables(max = 5) {
    const out = [];
    for (const t of document.querySelectorAll('table')) {
      if (out.length >= max) break;
      if (t.closest(CHROME) || t.querySelector('table') || !visible(t)) continue;
      const rows = [...t.rows].slice(0, 31).map((r) => [...r.cells].slice(0, 10).map((c) => norm(c.innerText).slice(0, 120)));
      if (rows.length < 2 || Math.max(...rows.map((r) => r.length)) < 2) continue;
      let columns = [];
      const head = t.tHead && t.tHead.rows[0];
      if (head) {
        columns = [...head.cells].slice(0, 10).map((c) => norm(c.innerText).slice(0, 80));
        rows.shift();
      } else if (t.rows[0] && [...t.rows[0].cells].every((c) => c.tagName === 'TH')) {
        columns = rows.shift();
      }
      const body = rows.filter((r) => r.some(Boolean)).slice(0, 30);
      if (!body.length) continue;
      let caption = t.caption ? norm(t.caption.innerText) : '';
      if (!caption) {
        let p = t.previousElementSibling;
        for (let i = 0; p && i < 3 && !caption; i++, p = p.previousElementSibling) if (/^H[1-6]$/.test(p.tagName)) caption = norm(p.innerText);
      }
      out.push({ ref: refFor(t), caption: caption.slice(0, 120), columns, rows: body });
    }
    return out;
  }

  function images(article) {
    const out = [];
    const add = (u) => {
      try {
        const x = new URL(u, location.href);
        if (x.protocol === 'https:' && !out.includes(x.href)) out.push(x.href);
      } catch { /* bad url */ }
    };
    const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
    if (og) add(og);
    for (const img of document.querySelectorAll('article img, main img, img')) {
      if (out.length >= 5) break;
      if (img.naturalWidth >= 300 && img.naturalHeight >= 160 && visible(img) && !img.closest(CHROME)) add(img.currentSrc || img.src);
    }
    if (article && article.image) add(article.image);
    return out.slice(0, 5);
  }

  function extract(opts = {}) {
    const art = readability();
    let list = blockPassages();
    if (list.reduce((n, p) => n + p.text.length, 0) < 400) list = list.concat(divPassages());
    // article pages: keep only passages Readability saw in the main content
    let mode = 'page';
    if (art && art.content) {
      const doc = new DOMParser().parseFromString(art.content, 'text/html');
      const keys = new Set([...doc.querySelectorAll(BLOCK)].map((e) => T.textKey(e.textContent)).filter(Boolean));
      const main = list.filter((p) => keys.has(T.textKey(p.text)));
      const covered = main.reduce((n, p) => n + p.text.length, 0);
      if (covered > Math.min(1500, art.textContent.length * 0.4)) {
        list = main;
        mode = 'article';
      }
    }
    if (opts.from === 'scroll') {
      list = list.filter((p) => p.el.getBoundingClientRect().bottom > 40);
    }
    // sections: passages under their nearest heading
    let section = '';
    const passages = [];
    const headings = [];
    for (const p of list) {
      if (p.heading) {
        section = p.text.slice(0, 160);
        if (headings.length < 40) headings.push({ level: Number(p.tag[1]), text: section, ref: refFor(p.el) });
      }
      passages.push({ id: refFor(p.el), tag: p.tag, text: p.text, section });
    }
    const ld = jsonLd();
    const timeEl = document.querySelector('time[datetime]');
    const contentChars = passages.filter((p) => !/^h[1-6]$/.test(p.tag)).reduce((n, p) => n + p.text.length, 0);
    const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 3000);
    const captchaFrame = !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#challenge-form,#cf-challenge-running,.cf-turnstile,[data-sitekey]');
    const hasPassword = [...document.querySelectorAll('input[type=password]')].some(visible);
    const scrollEl = document.scrollingElement || document.documentElement;
    return {
      url: location.href,
      title: norm(meta('meta[property="og:title"]') || document.title || (art && art.title) || '').slice(0, 300),
      description: (meta('meta[name="description"]') || meta('meta[property="og:description"]') || (art && art.excerpt) || '').slice(0, 600),
      siteName: (meta('meta[property="og:site_name"]') || (art && art.siteName) || location.hostname.replace(/^www\./, '')).slice(0, 120),
      og: { type: meta('meta[property="og:type"]'), image: meta('meta[property="og:image"]') },
      canonical: (document.querySelector('link[rel=canonical]') || {}).href || '',
      lang: (document.documentElement.lang || (art && art.lang) || '').slice(0, 20),
      author: norm(meta('meta[name="author"]') || meta('meta[property="article:author"]') || ld.author || (art && art.byline) || '').slice(0, 120),
      published: (meta('meta[property="article:published_time"]') || ld.published || (timeEl && timeEl.getAttribute('datetime')) || (art && art.publishedTime) || '').slice(0, 40),
      mode,
      passages,
      headings,
      tables: tables(),
      facts: T.findFacts(passages),
      images: images(art),
      contentChars,
      blockSignals: { title: document.title, text: bodyText, hasPassword, captchaFrame, contentChars },
      scroll: { y: scrollEl.scrollTop, h: scrollEl.scrollHeight, view: innerHeight },
    };
  }

  // ---------- highlight / scroll ----------
  function ensureStyle() {
    if (document.getElementById('__jv-style')) return;
    const s = document.createElement('style');
    s.id = '__jv-style';
    s.textContent = '.__jv-hl{outline:3px solid rgba(91,225,240,.95)!important;outline-offset:3px!important;background-color:rgba(91,225,240,.18)!important;border-radius:3px;transition:outline-color .6s,background-color .6s}.__jv-hl.__jv-out{outline-color:rgba(91,225,240,0)!important;background-color:transparent!important}';
    (document.head || document.documentElement).append(s);
  }

  function highlight(ref) {
    const el = nodes.get(ref);
    if (!el || !el.isConnected) return false;
    ensureStyle();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('__jv-out');
    el.classList.add('__jv-hl');
    clearTimeout(el.__jvT);
    el.__jvT = setTimeout(() => {
      el.classList.add('__jv-out');
      setTimeout(() => el.classList.remove('__jv-hl', '__jv-out'), 700);
    }, 2600);
    return true;
  }

  /** The element that actually scrolls (the window, or the biggest inner scroller). */
  function scroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 40) return se;
    let best = null;
    for (const el of document.querySelectorAll('main,div,section,article')) {
      if (el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < innerHeight * 0.4) continue;
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth)) best = el;
    }
    return best || se;
  }

  function scroll(dir) {
    const el = scroller();
    if (dir === 'top') el.scrollTo({ top: 0, behavior: 'smooth' });
    else el.scrollBy({ top: (dir === 'up' ? -1 : 1) * el.clientHeight * 0.8, behavior: 'smooth' });
    return true;
  }

  // ---------- links (navigation only) ----------
  const key = (s) => norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  function findLink(query) {
    const q = key(query);
    if (!q) return { kind: 'none' };
    const score = (label) => {
      const k = key(label);
      if (!k) return 0;
      if (k === q) return 3;
      if (k.startsWith(q) || q.startsWith(k)) return 2;
      if (k.includes(q)) return 1;
      return 0;
    };
    let best = null;
    for (const a of document.querySelectorAll('a[href]')) {
      const label = norm(a.innerText || a.getAttribute('aria-label') || a.title || '');
      const s = score(label);
      if (!s || !visible(a)) continue;
      let href = '';
      try { href = new URL(a.getAttribute('href'), location.href).href; } catch { continue; }
      if (!/^https?:/i.test(href)) continue;
      if (!best || s > best.s) best = { s, href, label };
      if (s === 3) break;
    }
    if (best) return { kind: 'link', href: best.href, label: best.label.slice(0, 120) };
    for (const b of document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')) {
      const label = norm(b.innerText || b.value || b.getAttribute('aria-label') || b.title || '');
      if (score(label) && visible(b)) return { kind: 'button', ref: refFor(b), label: label.slice(0, 120) };
    }
    return { kind: 'none' };
  }

  /** Only after the user confirmed it on screen. */
  function clickButton(ref) {
    const el = nodes.get(ref);
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }

  function pauseMedia() {
    document.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch { /* ignore */ } });
    return true;
  }

  window.__jv = { v: 2, settle, extract, highlight, scroll, findLink, clickButton, pauseMedia };
})();
