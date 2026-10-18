// Pure text helpers for the Web Viewer page reader. Runs in two places:
//   • Node (main process, unit tests): module.exports
//   • inside web pages (our isolated world): window.__jvText
// so it must stay plain ES2020 with no imports.
(function (root) {
  'use strict';

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // ---------- key facts: prices, percentages, dates, other numbers ----------
  const CUR = '(?:฿|\\$|€|£|¥|₩|US\\$|USD|THB|EUR|JPY|บาท|ดอลลาร์|เยน|ยูโร)';
  const NUMS = '\\d{1,3}(?:[,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
  const RE_PRICE = new RegExp(`(?:${CUR}\\s?(?:${NUMS})(?:\\s?(?:ล้าน|พัน|แสน|k|K|M|bn|million|billion))?|(?:${NUMS})(?:\\s?(?:ล้าน|พัน|แสน|k|K|M|bn|million|billion))?\\s?${CUR})`, 'g');
  const RE_PCT = new RegExp(`[+\\-−]?(?:${NUMS})\\s?(?:%|เปอร์เซ็นต์|percent)`, 'g');
  const TH_MONTHS = 'ม\\.?ค\\.?|ก\\.?พ\\.?|มี\\.?ค\\.?|เม\\.?ย\\.?|พ\\.?ค\\.?|มิ\\.?ย\\.?|ก\\.?ค\\.?|ส\\.?ค\\.?|ก\\.?ย\\.?|ต\\.?ค\\.?|พ\\.?ย\\.?|ธ\\.?ค\\.?|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม';
  const EN_MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const RE_DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b|\\d{1,2}\\s?(?:${TH_MONTHS})\\s?(?:\\d{2,4})?|\\b\\d{1,2}\\s(?:${EN_MONTHS})\\.?,?\\s\\d{4}\\b|\\b(?:${EN_MONTHS})\\.?\\s\\d{1,2},?\\s\\d{4}\\b`, 'g');

  /**
   * Facts spotted in passages: [{ kind, value, context, ref }] (≤ max).
   * Context is the passage text around the value (for the summarizer, which
   * turns the useful ones into label / value rows).
   */
  function findFacts(passages, max = 40) {
    const out = [];
    const seen = new Set();
    for (const p of passages || []) {
      const text = norm(p.text);
      for (const [kind, re] of [['price', RE_PRICE], ['percent', RE_PCT], ['date', RE_DATE]]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) && out.length < max) {
          const value = norm(m[0]);
          if (!/\d/.test(value)) continue;
          const key = `${kind}:${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const a = Math.max(0, m.index - 60);
          out.push({ kind, value, context: text.slice(a, m.index + m[0].length + 60), ref: p.id });
        }
      }
      if (out.length >= max) break;
    }
    return out;
  }

  // ---------- captcha / bot check / login wall ----------
  const BLOCK_TEXT = [
    /verify (?:that )?you are (?:a )?human/i, /are you a robot/i, /i'?m not a robot/i, /unusual traffic/i,
    /checking (?:if the site connection is secure|your browser)/i, /just a moment\.\.\./i, /attention required/i,
    /enable javascript and cookies to continue/i, /press (?:&|and) hold/i, /complete the security check/i,
    /please verify you are a human/i, /access (?:to this page has been )?denied/i, /request blocked/i,
    /ยืนยันว่าคุณไม่ใช่(?:โปรแกรม|บอท|หุ่นยนต์)/, /ยืนยันตัวตนว่าเป็นมนุษย์/,
  ];
  const LOGIN_TEXT = [/\b(?:log ?in|sign ?in)\b/i, /เข้าสู่ระบบ/, /ลงชื่อเข้าใช้/, /ล็อกอิน/];
  const PAYWALL_TEXT = [/subscribe to (?:continue|read)/i, /create a free account to continue/i, /สมัครสมาชิกเพื่ออ่านต่อ/];

  /**
   * s: { title, text (first ~3000 chars of visible text), status, hasPassword,
   *      captchaFrame, contentChars (chars of real passages) }
   * → { blocked: bool, kind: 'captcha' | 'login' | 'paywall' | 'http' | '' }
   */
  function blockedSignals(s) {
    const title = norm(s.title);
    const text = norm(s.text).slice(0, 3000);
    const thin = (s.contentChars || 0) < 700;
    if (s.captchaFrame) return { blocked: true, kind: 'captcha' };
    if (BLOCK_TEXT.some((re) => re.test(title)) || (thin && BLOCK_TEXT.some((re) => re.test(text)))) return { blocked: true, kind: 'captcha' };
    if ([401, 403, 407, 429].includes(s.status) && thin) return { blocked: true, kind: 'http' };
    if (s.hasPassword && thin) return { blocked: true, kind: 'login' };
    if (thin && LOGIN_TEXT.some((re) => re.test(title))) return { blocked: true, kind: 'login' };
    if (thin && PAYWALL_TEXT.some((re) => re.test(text))) return { blocked: true, kind: 'paywall' };
    return { blocked: false, kind: '' };
  }

  // ---------- long pages ----------
  /** Split passages into chunks of ≤ maxChars (a passage is never split). */
  function chunkPassages(passages, maxChars = 12000) {
    const chunks = [];
    let cur = [];
    let n = 0;
    for (const p of passages || []) {
      const len = String(p.text || '').length + 8;
      if (cur.length && n + len > maxChars) {
        chunks.push(cur);
        cur = [];
        n = 0;
      }
      cur.push(p);
      n += len;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /** Reading time in minutes: Thai ≈ 900 chars/min, other scripts ≈ 230 words/min. */
  function readingMinutes(text) {
    const t = String(text || '');
    const thai = (t.match(/[฀-๿]/g) || []).length;
    const words = (t.replace(/[฀-๿]+/g, ' ').match(/\S+/g) || []).length;
    return Math.max(1, Math.round(thai / 900 + words / 230));
  }

  /** Compact key for matching passages across Readability's copy and the live DOM. */
  function textKey(s) {
    return norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
  }

  const api = { norm, findFacts, blockedSignals, chunkPassages, readingMinutes, textKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__jvText = api;
})(typeof window !== 'undefined' ? window : globalThis);
