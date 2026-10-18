// Pure helpers for the Result Viewer (no DOM): URL safety, YouTube ids, Thai relative time.
// Unit-tested in test/viewer.test.js.

/** http(s) URL or null. */
export function safeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const x = new URL(u.trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;
  } catch {
    return null;
  }
}

export function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** YouTube video id from an item ({videoId} or a watch / youtu.be / shorts URL), validated. */
export function youtubeId(x) {
  const ok = (v) => (typeof v === 'string' && /^[\w-]{11}$/.test(v) ? v : null);
  if (!x) return null;
  if (typeof x === 'object') return ok(x.videoId) || youtubeId(x.url);
  try {
    const u = new URL(x);
    if (!/(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return null;
    if (u.hostname.endsWith('youtu.be')) return ok(u.pathname.slice(1, 12));
    if (u.searchParams.get('v')) return ok(u.searchParams.get('v'));
    const m = /\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname);
    return m ? ok(m[1]) : null;
  } catch {
    return null;
  }
}

/** "5 นาทีที่แล้ว", "2 ชม.ที่แล้ว", "เมื่อวาน", "3 วันที่แล้ว", else a Thai date. Unknown → ''. */
export function relTime(s, now = Date.now()) {
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return String(s).slice(0, 40); // already human text ("2 hours ago")
  const d = Math.max(0, now - t) / 1000;
  if (d < 60) return 'เมื่อสักครู่';
  if (d < 3600) return `${Math.floor(d / 60)} นาทีที่แล้ว`;
  if (d < 86400) return `${Math.floor(d / 3600)} ชม.ที่แล้ว`;
  if (d < 172800) return 'เมื่อวาน';
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} วันที่แล้ว`;
  return new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}
