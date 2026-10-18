'use strict';
// Web pages for the Result Viewer (main process).
//   inspect(url) → { ok, url, frameable, title, siteName, image, description, published, blocks }
// frameable: false when X-Frame-Options / CSP frame-ancestors forbid embedding,
// then the viewer shows a "reader view" built from `blocks` — plain text only
// ({ kind: 'h' | 'p' | 'li' | 'quote', text }). No HTML from the page ever
// reaches the renderer.
//
// Safety: http(s) only, no credentials in URLs, every hop (redirects too) must
// resolve to a public address (no localhost / LAN / link-local), 10 s timeout,
// 3 MB cap.

const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** Throws unless the URL is http(s) on a public host. */
async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL ไม่ถูกต้อง'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('เปิดได้เฉพาะ http/https');
  if (u.username || u.password) throw new Error('URL มีชื่อผู้ใช้/รหัสผ่าน');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || /\.local$/i.test(host)) throw new Error('ไม่เปิดที่อยู่ในเครื่อง/เครือข่ายภายใน');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('ไม่เปิดที่อยู่ในเครื่อง/เครือข่ายภายใน');
  return u;
}

/** Can this response be shown in an iframe on another origin? */
function frameable(headers) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
  const csp = (headers.get('content-security-policy') || '').toLowerCase();
  const m = /frame-ancestors([^;]*)/.exec(csp);
  if (m && !/(^|\s)\*(\s|$)/.test(m[1])) return false;
  return true;
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function decode(buf, contentType) {
  let cs = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

async function inspect(raw) {
  let url = (await checkUrl(raw)).toString();
  let res;
  for (let hop = 0; ; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      res = await fetch(url, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'th,en;q=0.8' } });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error('redirect มากเกินไป');
      url = (await checkUrl(new URL(res.headers.get('location'), url).toString())).toString();
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`โหลดไม่สำเร็จ (HTTP ${res.status})`);
  const type = res.headers.get('content-type') || '';
  if (!/html|xml/i.test(type)) return { ok: true, url, frameable: frameable(res.headers), title: url, siteName: new URL(url).hostname, blocks: [], nonHtml: true };
  const html = decode(await readCapped(res), type);
  return { ok: true, url, frameable: frameable(res.headers), ...extract(html, url) };
}

// ---------- reader-view extraction (plain text out) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', middot: '·', bull: '•' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const text = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return '';
  const c = /content=["']([^"']*)["']/i.exec(tag[0]);
  return c ? decodeEntities(c[1]).trim() : '';
}

function absUrl(u, base) {
  try {
    const x = new URL(u, base);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : '';
  } catch {
    return '';
  }
}

function extract(html, base) {
  const title = meta(html, 'og:title') || text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const siteName = meta(html, 'og:site_name') || (() => { try { return new URL(base).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const image = absUrl(meta(html, 'og:image') || meta(html, 'twitter:image'), base);
  const description = meta(html, 'og:description') || meta(html, 'description');
  const published = meta(html, 'article:published_time') || meta(html, 'date');
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|button|select|template|figure)\b[\s\S]*?<\/\1>/gi, ' ');
  const pick = (tag) => {
    let best = '';
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    while ((m = re.exec(body))) if (m[1].length > best.length) best = m[1];
    return best;
  };
  body = pick('article') || pick('main') || pick('body') || body;
  const blocks = [];
  let chars = 0;
  const re = /<(h[1-4]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) && blocks.length < 150 && chars < 40000) {
    const t = text(m[2]);
    const tag = m[1].toLowerCase();
    const kind = tag[0] === 'h' ? 'h' : tag === 'li' ? 'li' : tag === 'blockquote' ? 'quote' : 'p';
    if (!t || (kind !== 'h' && t.length < 25)) continue;
    if (blocks.length && blocks[blocks.length - 1].text === t) continue;
    blocks.push({ kind, text: t.slice(0, 4000) });
    chars += t.length;
  }
  return { title: title.slice(0, 300), siteName: siteName.slice(0, 120), image, description: description.slice(0, 600), published, blocks };
}

module.exports = { inspect, extract, isPrivateIp, checkUrl, frameable };
