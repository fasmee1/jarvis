'use strict';
// Pure helpers for the Web Viewer (no Electron imports, unit-tested).

/** Desktop Chrome UA for the bundled Chromium, without the "Electron" token. */
function chromeUserAgent(chromeVersion, platform = process.platform) {
  const major = String(chromeVersion || '140').split('.')[0];
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
  // Chrome ships a reduced UA: only the major version is real
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const SEARCH = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

/**
 * What the user typed in the address bar → a URL to load.
 * "github.com" → https://github.com/ · "localhost:3000" → http://localhost:3000/
 * "ราคาทอง" → a Google search. Only http(s) comes out.
 */
function normalizeAddress(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).toString(); } catch { return SEARCH(s); }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(localhost|[\w-]+(\.[\w-]+)+):\d+/i.test(s)) return SEARCH(s); // other schemes are never loaded
  if (!/\s/.test(s)) {
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(s);
    const ip = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s);
    const domain = /^([\p{L}\p{M}\p{N}-]+\.)+[\p{L}\p{M}]{2,}(:\d+)?(\/|\?|#|$)/u.test(s);
    if (local || ip || domain) {
      try { return new URL(`${local || ip ? 'http' : 'https'}://${s}`).toString(); } catch { /* fall through */ }
    }
  }
  return SEARCH(s);
}

// Spoken site names (Thai / English / common whisper spellings) → home page.
const SITES = [
  ['https://pantip.com/', ['pantip', 'พันทิป', 'พันทิพ', 'พันธ์ทิป']],
  ['https://github.com/', ['github', 'กิตฮับ', 'กิทฮับ', 'กิตฮัพ']],
  ['https://www.youtube.com/', ['youtube', 'ยูทูบ', 'ยูทูป', 'ยูทิวบ์']],
  ['https://www.google.com/', ['google', 'กูเกิล', 'กูเกิ้ล']],
  ['https://www.facebook.com/', ['facebook', 'เฟซบุ๊ก', 'เฟสบุ๊ค', 'เฟซบุ๊ค']],
  ['https://x.com/', ['twitter', 'ทวิตเตอร์', 'x']],
  ['https://th.wikipedia.org/', ['wikipedia', 'วิกิพีเดีย', 'วิกิ']],
  ['https://www.thairath.co.th/', ['thairath', 'ไทยรัฐ']],
  ['https://www.sanook.com/', ['sanook', 'สนุก', 'สนุกดอทคอม']],
  ['https://www.kapook.com/', ['kapook', 'กะปุก']],
  ['https://www.bangkokpost.com/', ['bangkokpost', 'บางกอกโพสต์']],
  ['https://shopee.co.th/', ['shopee', 'ช้อปปี้', 'ช็อปปี้']],
  ['https://www.lazada.co.th/', ['lazada', 'ลาซาด้า']],
  ['https://www.reddit.com/', ['reddit', 'เรดดิท']],
  ['https://stackoverflow.com/', ['stackoverflow', 'สแต็กโอเวอร์โฟลว์']],
  ['https://www.bbc.com/', ['bbc', 'บีบีซี']],
  ['https://mail.google.com/', ['gmail', 'จีเมล']],
  ['https://www.netflix.com/', ['netflix', 'เน็ตฟลิกซ์']],
  ['https://www.tmd.go.th/', ['กรมอุตุ', 'กรมอุตุนิยมวิทยา', 'tmd']],
  ['https://claude.ai/', ['claude', 'คลอด']],
];
const SITE_MAP = new Map(SITES.flatMap(([url, names]) => names.map((n) => [n.toLowerCase().replace(/\s+/g, ''), url])));

/** "pantip" / "พันทิป" / "github.com" → URL, or null when unknown (let Claude find it). */
function resolveSite(name) {
  const raw = String(name || '').trim().replace(/[.。]+$/, '');
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, '').replace(/^(เว็บ|เว็บไซต์|หน้า|site|website)/, '');
  if (SITE_MAP.has(key)) return SITE_MAP.get(key);
  if (/^https?:\/\//i.test(raw) || /^([\p{L}\p{M}\p{N}-]+\.)+[\p{L}\p{M}]{2,}(\/\S*)?$/u.test(raw.replace(/\s+/g, ''))) {
    const u = normalizeAddress(raw.replace(/\s+/g, ''));
    return u && !u.startsWith('https://www.google.com/search') ? u : null;
  }
  return null;
}

/** Renderer rect (CSS px, may be fractional) → integer DIP bounds, or null if empty. */
function dipBounds(rect, zoom = 1) {
  if (!rect) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.round(rect.x * z);
  const y = Math.round(rect.y * z);
  const w = Math.round((rect.x + rect.width) * z) - x;
  const hh = Math.round((rect.y + rect.height) * z) - y;
  if (!(w > 0 && hh > 0)) return null;
  return { x, y, width: w, height: hh };
}

/** Schemes a web tab may load itself. Everything else is blocked or goes to the OS (after asking). */
function isLoadable(url) {
  return /^(https?:|about:blank$|blob:|data:)/i.test(String(url || ''));
}

/** Internal schemes a page must never navigate to. */
function isForbidden(url) {
  return /^(file|chrome|chrome-extension|chrome-untrusted|devtools|view-source|app|javascript):/i.test(String(url || ''));
}

/** Address shown in the bar: { secure, host, rest }. */
function splitAddress(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { secure: false, host: url, rest: '' };
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return { secure: u.protocol === 'https:', host: u.host.replace(/^www\./, ''), rest };
  } catch {
    return { secure: false, host: String(url || ''), rest: '' };
  }
}

module.exports = { chromeUserAgent, normalizeAddress, resolveSite, dipBounds, isLoadable, isForbidden, splitAddress, SEARCH };
