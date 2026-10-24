// Boot sequence — one calm GSAP timeline (≈2.8 s): frame → reactor → status →
// connectors → cards → ready. Every element arrives with a fade, an 8px
// translate and a slight scale from 0.98; cards follow a soft 60 ms stagger;
// lines draw in and numbers count up softly. No glitches, flashes or shakes.
// Canvas parts (rings, arc, lines, nodes, logo) are driven by tweening plain
// parameter objects. Click / any key skips to the final state.
//
// Emits `app:ready` on window when the UI is fully usable.

import { sfx, requireGestureForAudio } from '../sfx.js';
import './ease.js';

const gsap = window.gsap;
if (gsap) gsap.config({ nullTargetWarn: false });
const $ = (id) => document.getElementById(id);
const PANEL_ORDER = ['reply', 'mic', 'tts', 'latency', 'tokens', 'elapsed', 'step', 'camera'];
const PREF = { mode: 'jarvis.bootMode', seen: 'jarvis.booted' };
const IN = { opacity: 0, y: 8, scale: 0.98 }; // how every element starts

function pref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function setPref(key, v) {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

export const bootPrefs = {
  get mode() { return pref(PREF.mode, 'always'); }, // 'always' | 'first'
  set mode(v) { setPref(PREF.mode, v); },
  // boot sounds can be muted on their own (interaction sounds stay on)
  get sound() { return !sfx.bootMuted; },
  set sound(v) { sfx.setBootMuted(!v); },
};

/**
 * Browser only: a dim reactor outline with pulsing text that waits for the first
 * click / key so the AudioContext may start. Resolves after that gesture.
 * (Electron sets autoplay-policy=no-user-gesture-required and skips this.)
 */
function initScreen() {
  return new Promise((resolve) => {
    const scr = document.createElement('div');
    scr.className = 'boot-init';
    scr.innerHTML = '<div class="bi-reactor" aria-hidden="true"><i></i><i></i><i></i></div>'
      + '<div class="bi-text">แตะเพื่อเริ่มระบบ · CLICK TO INITIALIZE</div>';
    document.body.append(scr); // silent: the first sound plays only after the gesture
    const go = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeEventListener('keydown', go, true);
      removeEventListener('pointerdown', go, true);
      await sfx.unlock();
      scr.remove();
      resolve();
    };
    addEventListener('keydown', go, true);
    addEventListener('pointerdown', go, true);
  });
}

/** Count a "number + suffix" text up from 0 (keeps decimals / zero padding). */
function countUp(span, dur = 0.6) {
  const final = span.textContent;
  const m = /^(-?)(\d+)(?:\.(\d+))?(.*)$/.exec(final);
  if (!m) return null;
  const dec = m[3] ? m[3].length : 0;
  const pad = m[2].length > 1 && m[2].startsWith('0') ? m[2].length : 0;
  const target = parseFloat(`${m[1]}${m[2]}.${m[3] || 0}`);
  const o = { v: 0 };
  const tw = gsap.to(o, {
    v: target,
    duration: dur,
    ease: 'calm',
    onUpdate() {
      let s = Math.abs(o.v).toFixed(dec);
      if (pad) s = s.padStart(pad, '0');
      span.textContent = `${o.v < 0 || m[1] ? '-' : ''}${s}${m[4]}`;
    },
    onComplete() { span.textContent = final; },
  });
  return { tw, final, span };
}

/**
 * Play (or skip) the boot sequence.
 * @returns {Promise<{ greet: Promise<void> }>} resolves when `app:ready` fires;
 *   `greet` resolves when the optional voice greeting should start, just
 *   after the ready chime.
 */
export async function runBoot({ home }) {
  if (requireGestureForAudio && sfx.enabled && !sfx.failed) await initScreen();
  // audio clock running before the first sound (desktop started warming at app load)
  await (sfx.warmStart || sfx.warmup(800));
  return playBoot({ home });
}

function playBoot({ home }) {
  return new Promise((resolve) => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const firstOnly = bootPrefs.mode === 'first';
    const seen = pref(PREF.seen, '') === '1';
    const body = document.body;
    const overlay = $('boot-overlay');
    let done = false;
    const counters = [];

    // optional voice greeting (app.js) starts when `greet` resolves: after the chime
    let greetNow;
    const greet = new Promise((r) => { greetNow = r; });
    const greetIn = (ms) => setTimeout(greetNow, ms);
    /** Skip / short paths: just the ready chime. */
    const chimeOnly = () => {
      sfx.ready();
      greetIn(900);
    };

    const ready = () => {
      setPref(PREF.seen, '1');
      window.dispatchEvent(new CustomEvent('app:ready'));
      resolve({ greet });
    };

    // Short path: reduced motion, gsap missing, or "first launch only" already seen.
    if (!gsap || reduced || (firstOnly && seen)) {
      if (reduced) {
        sfx.powerOn();
        setTimeout(chimeOnly, 400);
      } else {
        chimeOnly();
      }
      overlay.hidden = true;
      home.booting = false;
      home.applyLabel();
      if (gsap && !reduced) {
        ready();
        return;
      }
      $('home').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }).finished.then(ready, ready);
      return;
    }

    body.classList.add('booting');
    home.booting = true;
    const cards = home.cards;
    const core = home.core;
    const ticks = home.ticks;
    // every visible node lights up; only cards that were open last time deploy
    // (docked cards boot straight into their docked node state)
    const nodesAll = PANEL_ORDER.map((id) => cards.cards.get(id)).filter((c) => c && !c.def.hidden);
    const isDocked = (c) => !!(home.docking && home.docking.isDocked(c.def.id));
    const visible = nodesAll.filter((c) => !isDocked(c));
    const B = core.beginBoot(nodesAll.map((c) => c.def.node));

    // ---------- initial (off) state ----------
    overlay.hidden = false;
    gsap.set(overlay, { opacity: 1 });
    gsap.set('#grid-bg', { opacity: 0 });
    const corners = [...document.querySelectorAll('.corner-brk')];
    const chrome = ['#hamburger', '#caption-tr', '.caption-bl'];
    gsap.set([...corners, ...chrome], IN);
    gsap.set(ticks.over, { opacity: 0 });
    gsap.set('.core-readout', { opacity: 0, y: 8 });
    $('state-label').textContent = '';
    const shells = new Map();
    for (const c of visible) {
      c.pl.setAttribute('pathLength', '1');
      gsap.set(c.pl, { strokeDasharray: '1 1', strokeDashoffset: -1 });
      gsap.set(c.dot, { opacity: 0 });
      const el = c.el;
      el.style.pointerEvents = 'none';
      // the card element's own transform belongs to the layout; animate its parts
      const shell = [el.querySelector('.fill'), el.querySelector('.frame'), el.querySelector('.in')];
      shells.set(c, shell);
      gsap.set(el, { opacity: 0 });
      gsap.set(shell, { y: 8, scale: 0.98, transformOrigin: '50% 50%' });
    }

    // ---------- the timeline ----------
    const tl = gsap.timeline({ defaults: { ease: 'calm' }, onComplete: () => finish(false) });
    const at = (t, fn) => tl.call(fn, null, t);

    // Sound: a soft power-on, one blip per card on a rising scale, the ready chime.
    // Every cue is a tl.call() on this timeline, so sound and picture stay in step.

    // 1. frame (0.0 → 0.6)
    at(0, () => sfx.powerOn());
    tl.to(overlay, { opacity: 0, duration: 0.5 }, 0)
      .to('#grid-bg', { opacity: 1, duration: 0.8 }, 0.05)
      .to([...corners, ...chrome], { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.04 }, 0.15);

    // 2. reactor (0.3 → 1.3): rings draw, ticks fade, logo, arc + line ring
    tl.to(B, { rings: 1, duration: 0.8 }, 0.3)
      .to(ticks.over, { opacity: 1, duration: 0.6 }, 0.45)
      .to(B, { logo: 1, duration: 0.6 }, 0.5)
      .to(B, { arc: 1, duration: 0.7 }, 0.6)
      .to(B, { lines: 72, duration: 0.6, ease: 'none' }, 0.6);

    // 3. status (0.7 → 1.4)
    const label = $('state-label');
    at(0.7, () => { label.textContent = 'INITIALIZING'; });
    tl.to('.core-readout', { opacity: 1, y: 0, duration: 0.5 }, 0.7)
      .to(label, { opacity: 0, duration: 0.15 }, 1.25);
    at(1.4, () => { label.textContent = 'SYSTEMS ONLINE'; });
    tl.to(label, { opacity: 1, duration: 0.25 }, 1.4);

    // 4. nodes + connectors (1.0 → 1.6)
    tl.to(B, { nodes: nodesAll.length, duration: 0.06 * nodesAll.length, ease: 'none' }, 1.0);
    visible.forEach((c, i) => {
      const t = 1.05 + i * 0.06;
      tl.to(c.pl, { strokeDashoffset: 0, duration: 0.45 }, t)
        .to(c.dot, { opacity: 1, duration: 0.3 }, t + 0.3);
    });

    // 5. cards (1.25 → ~2.2): fade + 8px + 0.98, 60 ms stagger; values count up softly
    visible.forEach((c, i) => {
      const t = 1.25 + i * 0.06;
      const el = c.el;
      at(t, () => sfx.panelOpen(i, sfx.panOf(el)));
      tl.to(el, { opacity: 1, duration: 0.5 }, t)
        .to(shells.get(c), { y: 0, scale: 1, duration: 0.6 }, t);
      at(t + 0.15, () => {
        for (const v of el.querySelectorAll('.val > span:first-child')) {
          const cu = countUp(v, 0.6);
          if (cu) counters.push(cu);
        }
      });
      at(t + 0.5, () => { el.style.pointerEvents = ''; });
    });

    // 6. ready (2.2 → 2.8)
    at(2.2, () => {
      sfx.ready();
      greetIn(900); // optional voice greeting follows the chime
      home.booting = false;
      gsap.to(label, { opacity: 0, duration: 0.15, onComplete: () => { home.applyLabel(); gsap.to(label, { opacity: 1, duration: 0.3 }); } });
    });
    at(2.3, () => {
      const dot = $('hb-dot');
      dot.classList.remove('boot-blink');
      void dot.offsetWidth;
      dot.classList.add('boot-blink');
      setTimeout(() => dot.classList.remove('boot-blink'), 900);
    });
    tl.to({}, { duration: 0.01 }, 2.8);

    // ---------- skip ----------
    const skip = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (done) return;
      sfx.quiet(400); // no click blip for the skip itself
      tl.kill();
      gsap.fromTo(overlay, { opacity: 0.4 }, { opacity: 0, duration: 0.2, ease: 'calm', onStart: () => { overlay.hidden = false; } });
      finish(true);
    };
    window.addEventListener('keydown', skip, true);
    window.addEventListener('mousedown', skip, true);

    // ---------- final state (also used by skip) ----------
    function finish(skipped) {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', skip, true);
      window.removeEventListener('mousedown', skip, true);
      for (const cu of counters) {
        cu.tw.kill();
        cu.span.textContent = cu.final;
      }
      core.endBoot();
      gsap.set(['#grid-bg', '.core-readout', label, ticks.over, ...corners, ...chrome], { clearProps: 'opacity,transform' });
      for (const c of visible) {
        const el = c.el;
        el.style.pointerEvents = '';
        el.style.opacity = '';
        gsap.set([c.pl, c.dot], { clearProps: 'strokeDasharray,strokeDashoffset,opacity' });
        gsap.set(shells.get(c), { clearProps: 'transform' });
      }
      if (home.docking) home.docking.restoreDocked();
      if (!skipped) overlay.hidden = true;
      else setTimeout(() => { overlay.hidden = true; }, 220);
      body.classList.remove('booting');
      home.booting = false;
      home.applyLabel();
      if (skipped) {
        // skip: fade every active boot sound over 0.2 s, then just the ready chime
        sfx.fadeGroup('boot', 0.2);
        setTimeout(chimeOnly, 200);
      }
      ready();
    }
  });
}
