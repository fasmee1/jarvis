// Built-in hands-free voice commands, handled locally (no AI round-trip).
// Only short, whole-utterance commands match, so "หยุดทำงานแล้วสรุปให้หน่อย"
// still goes to Claude. Pure module (no DOM), unit-tested in test/handsfree.test.js.
//
// Whisper spells short Thai words loosely ("ปิดการ์ดไมค์" → "ปิดกัดมาย",
// "จาร์วิส" → "จ้าวบิส"), so matching runs on a *folded* form: tone marks are
// dropped and a silenced consonant (X์) is removed, then card names are
// compared with a small edit distance.

const TONES = /[่-๋]/; // ่ ้ ๊ ๋
const THANTHAKHAT = '์'; // ์ (the letter before it is silent)

/** Folded text plus, for every folded char, its index in the original. */
function foldMap(text) {
  const src = String(text || '').normalize('NFC').toLowerCase();
  const out = [];
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (TONES.test(ch)) continue;
    if (ch === THANTHAKHAT) {
      // drop the silent letter (and a vowel mark between, as in "ทร์" / "ติ์")
      while (out.length && /[ัิ-ฺ]/.test(out[out.length - 1])) { out.pop(); map.pop(); }
      if (out.length) { out.pop(); map.pop(); }
      continue;
    }
    out.push(ch);
    map.push(i);
  }
  return { folded: out.join(''), map, src };
}

export const fold = (t) => foldMap(t).folded;

// "ดูนี่" / "ดูอันนี้" / "ดูหน้าจอ" — and how whisper often writes it ("โดนี่", "ดูนี้").
// Matched on folded text (no tone marks): นี่ / นี้ / นี all fold to นี, หน้า to หนา.
const SCREEN_LOOK = /(?:ดู|โด)\s*(?:อัน)?\s*นี|ดู\s*(?:หนา)?\s*จอ|look at (?:this|my screen)/i;
/** The user is pointing at something: with the camera off, JARVIS looks at the screen. */
export function wantsScreenLook(text) {
  return SCREEN_LOOK.test(fold(text));
}
const R = (src, flags = '') => new RegExp(fold(src), flags);

// Wake phrase as whisper writes it, on folded text: "จาร์วิส" "จาวิส" "จ้าวบิส"
// "ชาร์วิส" "จาวิด" "Jarvis" "Hey Jarvis" "เฮ้ จาร์วิส" … The lookahead stops it from
// eating the start of a longer word ("ชาววิสาหกิจ").
// core: optional เ, จ/ช, vowel, optional ร/บ/ว, ว/บ, ิ/ี, final s-like consonant
const WAKE_CORE = String.raw`(?:jarvis|jarvi|javis|jervis|jarvas|เ?(?:จ|ช)(?:า|อ|ะ|ั)?(?:ร|บ)?ว?(?:ว|บ)(?:ิ|ี)(?:ส|ซ|ท|ด|ต|ศ|ษ))(?![ะ-ฺๅ-๎])`;
const WAKE = new RegExp(String.raw`^(?:(?:hey|hi|ok|okay|เฮ|เฮย|เห|เหย|โอเค|เฮช)[\s,]*)?${WAKE_CORE}(?:\s*(?:ครับผม|ครับ|คับ|คะ|นะ|จะ))?[\s,.!?、，]*`, 'i');
/** Anywhere in the text (second-stage wake check on the audio around the detection). */
const WAKE_ANY = new RegExp(WAKE_CORE, 'i');

/** Transcript without the leading wake phrase ("จาร์วิส เปิดกล้อง" → "เปิดกล้อง"). */
export function stripWake(text) {
  let t = String(text || '').normalize('NFC').trim();
  for (let i = 0; i < 2; i++) {
    const { folded, map } = foldMap(t);
    const m = WAKE.exec(folded);
    if (!m || !m[0]) break;
    const cut = m[0].length >= folded.length ? t.length : map[m[0].length];
    t = t.slice(cut).trim(); // folding keeps original indices, so case is preserved
  }
  return t;
}

/** Whisper heard the wake word somewhere in this clip (used to confirm a Thai-head detection). */
export function containsWake(text) {
  return WAKE_ANY.test(fold(text));
}

/** The whole transcript is just the wake word (e.g. "จาร์วิส" said again in the follow-up). */
export function isWakeOnly(text) {
  const t = String(text || '').trim();
  return !!t && !tight(stripWake(t)) && WAKE.test(fold(t));
}

const POLITE = R('(?:\\s*(?:ครับผม|ครับ|คับ|ค่ะ|คะ|จ้ะ|จ้า|นะ|หน่อย|ที|เลย|please|now))+$', 'i');
/** Folded, punctuation-free, without trailing polite words or spaces. */
function tight(t) {
  return fold(t).replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0E50)).replace(/[“”"'‘’`.,!?;:()[\]{}…。、，！？\-–—]/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(/\s+/g, '');
}

// Card names (Thai / English, incl. common whisper spellings) → card ids in ui/cards.js
export const CARD_ALIASES = {
  reply: ['lastreply', 'reply', 'คำตอบล่าสุด', 'คำตอบ', 'ข้อความตอบกลับ', 'ตอบกลับ', 'ลาสต์รีพลาย', 'รีพลาย'],
  mic: ['mic', 'microphone', 'ไมค์', 'ไมโครโฟน', 'ไมก์', 'มาย', 'ไมด์', 'มิค'],
  tts: ['tts', 'ทีทีเอส', 'เสียงพูด', 'เสียงตอบ'],
  latency: ['latency', 'เลเทนซี', 'เลเทนซี่', 'ความหน่วง', 'ความเร็ว'],
  step: ['step', 'steps', 'สเต็ป', 'สเตป', 'ขั้นตอน'],
  tokens: ['tokens', 'token', 'โทเคน', 'โทเค็น', 'โทเคิ่น', 'โทเคนส์'],
  elapsed: ['elapsed', 'อีแลปส์', 'อีแลป', 'เวลา', 'เวลาที่ผ่านไป', 'จับเวลา'],
  camera: ['camera', 'cam', 'กล้อง', 'คาเมร่า', 'แคม'],
};
const ALIASES = Object.entries(CARD_ALIASES).flatMap(([id, names]) => names.map((n) => [id, tight(n)]));

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

function cardId(name) {
  const n = tight(name);
  if (!n) return null;
  let best = null;
  for (const [id, a] of ALIASES) {
    if (a === n) return id;
    const tol = a.length >= 6 ? 2 : a.length >= 3 ? 1 : 0;
    const dd = lev(n, a);
    if (dd <= tol && (!best || dd < best.d)) best = { id, d: dd };
  }
  return best ? best.id : null;
}

const CMD = {
  stop: R('^(?:หยุด|หยุดพูด|หยุดก่อน|เงียบ|stop|stopit|stoptalking|shutup)$'),
  done: R('^(?:พอแล้ว|พอ|พอก่อน|แค่นี้|แค่นี้แหละ|เท่านี้|ขอบคุณ|ขอบคุณมาก|ขอบใจ|thatsall|thatsit|thatisall|done|nevermind|thankyou|thanks|thankyouverymuch)$'),
  off: R('^(?:ปิด|บิด|เลิก|หยุด)(?:โหมด)?(?:แฮนด์ฟรี|แฮนฟรี|แฮนด์ฟรีส์|แฮนฟี|handsfree|handfree)(?:โหมด)?$'),
  offEn: /^(?:turnoff|disable|stop)handsfree(?:mode)?$/,
  camOn: R('^(?:(?:เปิด|เบิด|เบอร์|แบบ)(?:กล้อง|กล้าง|กลอง)|เปิดแคม|cameraon|turnonthecamera|turnoncamera|opencamera|openthecamera)$'),
  camOff: R('^(?:ปิดกล้อง|บิดกล้อง|ปิดแคม|cameraoff|turnoffthecamera|turnoffcamera|closecamera|closethecamera)$'),
  // "การ์ด" as whisper writes it: การ์ด กาด กัด คาร์ด คาด
  close: R('^(?:ปิด|บิด|เก็บ)(?:การ์ด|กาด|กัด|คาร์ด|คาด|กาจ)(.+)$'),
  open: R('^(?:เปิด|เบิด|แสดง)(?:การ์ด|กาด|กัด|คาร์ด|คาด|กาจ)(.+)$'),
  // the conversation popup ("บทสนทนา", also as whisper tends to spell it)
  talkOpen: R('^(?:เปิด|เบิด|ดู|แสดง)(?:หน้า)?(?:บทสนทนา|บทสนธนา|บทสนทนาหน่อย|แชท|แชต)$|^(?:openconversation|showconversation|openthechat|openchat|showchat)$'),
  talkClose: R('^(?:ปิด|บิด|เก็บ|ซ่อน)(?:หน้า)?(?:บทสนทนา|บทสนธนา|แชท|แชต)$|^(?:closeconversation|hideconversation|closethechat|closechat|hidechat)$'),
  closeEn: /^(?:closecard|closethe|hide)(.+?)(?:card)?$/,
  openEn: /^(?:opencard|openthe|show)(.+?)(?:card)?$/,
};

/**
 * Match a transcript against the built-in commands.
 * @returns {null | { action: string, card?: string }}
 *   actions: stop | done | camera-on | camera-off | card-close | card-open | handsfree-off | talk-open | talk-close
 */
// ---------- Result Viewer (only while it is open) ----------
// numbers as said: digits, Thai words or English
const NUMW = { แรก: 1, หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10, first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4, fifth: 5, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUMF = Object.fromEntries(Object.entries(NUMW).map(([k, n]) => [fold(k), n]));
const NUM = `(\\d{1,2}|${Object.keys(NUMF).join('|')})`;
const toNum = (x) => (x == null || x === '' ? null : /^\d+$/.test(x) ? Number(x) : NUMF[x] || null);
const SEC = '(?:วินาที|วินา|วิ|seconds?|secs?|s)?'; // "วินา": the polite-word trim eats a final "ที"
const VIEW = {
  close: R('^(?:ปิด|ปิดหน้าจอ|ปิดจอ|ปิดหน้าต่าง|ปิดผลลัพธ์|ปิดวิดีโอ|ปิดคลิป|ปิดเลย|close|closeit|closethis|closeviewer|closewindow)$'),
  next: R('^(?:ถัดไป|อันถัดไป|ต่อไป|อันต่อไป|next|nextone)$'),
  prev: R('^(?:ก่อนหน้า|อันก่อนหน้า|ย้อนกลับ|previous|back|goback)$'),
  open: R(`^(?:เปิด|ดู|เลือก)(?:อัน|ลิงก์|ลิ้ง|ข่าว|ผล|คลิป|วิดีโอ|รูป|เว็บ|หน้า)?(?:ที่)?${NUM}$`),
  openEn: new RegExp(`^(?:open|show|select|play)(?:the)?(?:number|item|result|link)?${NUM}(?:one|item|result|link)?$`),
  read: R(`^อ่าน(?:อัน|ข่าว|ผล|ลิงก์|หัวข้อ)?(?:ที่)?${NUM}(?:ให้ฟัง)?$`),
  readEn: new RegExp(`^read(?:the)?(?:number|item|result)?${NUM}(?:one|item|result)?$`),
  down: R('^(?:เลื่อนลง|เลื่อนลงอีก|ลงอีก|scrolldown|down)$'),
  up: R('^(?:เลื่อนขึ้น|เลื่อนขึ้นอีก|scrollup|up)$'),
  external: R('^(?:เปิดในเบราว์เซอร์|เปิดในบราวเซอร์|เปิดเบราว์เซอร์|เปิดบราวเซอร์|เปิดข้างนอก|openinbrowser|openinthebrowser|openexternally)$'),
  play: R('^(?:เล่น|เล่นต่อ|เล่นวิดีโอ|เล่นคลิป|play|resume|playvideo)$'),
  pause: R('^(?:หยุด|หยุดวิดีโอ|หยุดคลิป|หยุดก่อน|พัก|พักก่อน|pause|stop|stopvideo)$'),
  fwd: R(`^(?:ข้าม|ข้ามไป|เดินหน้า|ไปข้างหน้า|skip|forward|skipforward)${NUM}?${SEC}$`),
  back: R(`^(?:ถอยหลัง|ย้อน|ถอย|rewind|skipback)${NUM}?${SEC}$`),
  louder: R('^(?:เสียงดังขึ้น|ดังขึ้น|ดังขึ้นอีก|เพิ่มเสียง|เร่งเสียง|volumeup|louder|turnitup)$'),
  softer: R('^(?:เสียงเบาลง|เบาลง|เบาลงอีก|ลดเสียง|volumedown|quieter|softer|turnitdown)$'),
};

// ---------- Web Viewer (a live web page is the current tab) ----------
const WEB = {
  summarize: R('^(?:สรุปหน้านี้|สรุปหน้าเว็บ|สรุปเว็บนี้|สรุปอีกครั้ง|สรุปใหม่|สรุปให้หน่อย|สรุป|summarize|summarizethis|summarizethispage|summary)$'),
  more: R('^(?:อ่านต่อ|สรุปต่อ|readmore|continuereading)$'),
  top: R('^(?:ไปบนสุด|ขึ้นบนสุด|กลับไปบนสุด|เลื่อนขึ้นบนสุด|บนสุด|scrolltotop|totop|top)$'),
  back: R('^(?:ย้อนกลับ|กลับหน้าก่อน|หน้าก่อน|ถอยกลับ|กลับ|goback|back)$'),
  forward: R('^(?:ไปข้างหน้า|หน้าถัดไป|เดินหน้า|forward|goforward)$'),
  reload: R('^(?:รีโหลด|โหลดใหม่|รีเฟรช|รีเฟรซ|reload|refresh)$'),
  nextTab: R('^(?:แท็บถัดไป|แทบถัดไป|แท็บต่อไป|nexttab)$'),
  closeTab: R('^(?:ปิดแท็บ|ปิดแทบ|ปิดแท็บนี้|closetab|closethistab)$'),
  expand: R('^(?:ขยายเว็บ|ขยายหน้าเว็บ|ขยาย|ซ่อนสรุป|expand|hidesummary)$'),
};
const WEB_OPS = [['summarize', 'summarize'], ['more', 'more'], ['top', 'top'], ['back', 'back'], ['forward', 'forward'], ['reload', 'reload'], ['nextTab', 'next-tab'], ['closeTab', 'close-tab'], ['expand', 'expand']];
// on the raw transcript (spaces kept): "คลิกลิงก์ ราคาทอง", "click the link pricing"
const CLICK = /^(?:คลิก|คลิ๊ก|กด|เปิด)\s*(?:ที่)?\s*ลิ(?:ง|้ง)ค?ก์?\s*(?:ที่ชื่อ|ชื่อ|ที่ว่า)?\s*(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย|ให้หน่อย|นะ)*[.!]?$|^click(?:\s+on)?(?:\s+the)?\s+link\s+(.+?)[.!]?$/i;

function webCommand(t, raw) {
  for (const [k, op] of WEB_OPS) if (WEB[k].test(t)) return { action: 'viewer', op };
  const m = CLICK.exec(raw);
  if (m && (m[1] || m[2])) return { action: 'viewer', op: 'click', text: (m[1] || m[2]).trim().slice(0, 200) };
  return null;
}

// "เปิดเว็บ pantip", "ไปที่ github.com", "open github" (anywhere; unknown names go to Claude)
const OPEN_SITE = /^(?:เปิดเว็บไซต์|เปิดเว็บ|เปิดหน้าเว็บ|เข้าเว็บ|ไปเว็บ|ไปที่เว็บ|ไปที่|open\s+(?:the\s+)?(?:website\s+)?|go\s+to\s+)\s*([\p{L}\p{N}][\p{L}\p{N}\p{M}.\-/:]*?)\s*(?:ครับ|ค่ะ|คะ|หน่อย|ให้หน่อย|นะ|please)*[.!]?$/iu;

function viewerCommand(t, ctx) {
  const v = (op, n) => ({ action: 'viewer', op, ...(n != null ? { n } : {}) });
  if (ctx.video) {
    if (VIEW.pause.test(t)) return v('pause');
    if (VIEW.play.test(t)) return v('play');
    let m = VIEW.fwd.exec(t);
    if (m) return v('seek', toNum(m[1]) || 10);
    m = VIEW.back.exec(t);
    if (m) return v('seek', -(toNum(m[1]) || 10));
    if (VIEW.louder.test(t)) return v('volume', 15);
    if (VIEW.softer.test(t)) return v('volume', -15);
  }
  if (VIEW.close.test(t)) return v('close');
  if (VIEW.next.test(t)) return v('next');
  if (VIEW.prev.test(t)) return v('prev');
  if (VIEW.down.test(t)) return v('scroll', 1);
  if (VIEW.up.test(t)) return v('scroll', -1);
  if (VIEW.external.test(t)) return v('external');
  for (const [re, op] of [[VIEW.open, 'open'], [VIEW.openEn, 'open'], [VIEW.read, 'read'], [VIEW.readEn, 'read']]) {
    const m = re.exec(t);
    if (m && toNum(m[1])) return v(op, toNum(m[1]));
  }
  return null;
}

/** ctx: { viewer: the Result Viewer is open, video: a video is loaded in it } */
export function parseCommand(transcript, ctx = {}) {
  const raw = stripWake(transcript).trim();
  const t = tight(raw);
  if (!t) return null;
  if (CMD.talkOpen.test(t)) return { action: 'talk-open' };
  if (CMD.talkClose.test(t)) return { action: 'talk-close' };
  if (ctx.viewer && ctx.web) {
    const wc = webCommand(t, raw);
    if (wc) return wc;
  }
  if (ctx.viewer) {
    const vc = viewerCommand(t, ctx);
    if (vc) return vc;
  }
  if (CMD.stop.test(t)) return { action: 'stop' };
  if (CMD.done.test(t)) return { action: 'done' };
  if (CMD.off.test(t) || CMD.offEn.test(t)) return { action: 'handsfree-off' };
  if (CMD.camOn.test(t)) return { action: 'camera-on' };
  if (CMD.camOff.test(t)) return { action: 'camera-off' };
  for (const [re, action] of [[CMD.close, 'card-close'], [CMD.closeEn, 'card-close'], [CMD.open, 'card-open'], [CMD.openEn, 'card-open']]) {
    const m = re.exec(t);
    if (!m) continue;
    const id = cardId(m[1]);
    if (id) return { action, card: id };
  }
  const site = OPEN_SITE.exec(raw);
  if (site) return { action: 'open-site', name: site[1].trim(), text: raw };
  return null;
}

/** Common whisper hallucinations on silence / noise — treated as "nothing said". */
const HALLUCINATIONS = R('^(?:ขอบคุณที่รับชม|ติดตามช่องของเรา|ฝากกดติดตาม.*|ซับไตเติ้ล.*|subtitlesby.*|thanksforwatching|you|เพลง|ดนตรี|music|เสียงเพลง|เสียงดนตรี)$', 'i');

export function isNoise(transcript) {
  const t = tight(stripWake(transcript));
  return !t || HALLUCINATIONS.test(t);
}
