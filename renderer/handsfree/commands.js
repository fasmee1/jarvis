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
  return fold(t).replace(/[“”"'‘’`.,!?;:()[\]{}…。、，！？\-–—]/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(/\s+/g, '');
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
  closeEn: /^(?:closecard|closethe|hide)(.+?)(?:card)?$/,
  openEn: /^(?:opencard|openthe|show)(.+?)(?:card)?$/,
};

/**
 * Match a transcript against the built-in commands.
 * @returns {null | { action: string, card?: string }}
 *   actions: stop | done | camera-on | camera-off | card-close | card-open | handsfree-off
 */
export function parseCommand(transcript) {
  const t = tight(stripWake(transcript));
  if (!t) return null;
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
  return null;
}

/** Common whisper hallucinations on silence / noise — treated as "nothing said". */
const HALLUCINATIONS = R('^(?:ขอบคุณที่รับชม|ติดตามช่องของเรา|ฝากกดติดตาม.*|ซับไตเติ้ล.*|subtitlesby.*|thanksforwatching|you|เพลง|ดนตรี|music|เสียงเพลง|เสียงดนตรี)$', 'i');

export function isNoise(transcript) {
  const t = tight(stripWake(transcript));
  return !t || HALLUCINATIONS.test(t);
}
