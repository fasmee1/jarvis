// Boot sequence: HUD plays ui/hud-boot.js, calm plays the ignition intro (ui/calm-intro.js).
// Reduced motion / "first launch only" / no GSAP take a short fade instead.
// Click / any key skips to the final state.
//
// Emits `app:ready` on window when the UI is fully usable.

import { sfx, requireGestureForAudio } from '../sfx.js';
import { playHudBoot } from './hud-boot.js';
import { playCalmIntro } from './calm-intro.js';
import { getIntroMode } from './hud-intro.js';
import { motionReduced } from './style-mode.js';
import './ease.js';

const gsap = window.gsap;
if (gsap) gsap.config({ nullTargetWarn: false });
const $ = (id) => document.getElementById(id);
const PREF = { mode: 'jarvis.bootMode', seen: 'jarvis.booted' };

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
    // calm also honours the app's own motion setting (HUD keeps its behaviour)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || (home.style === 'calm' && motionReduced());
    const firstOnly = bootPrefs.mode === 'first';
    const seen = pref(PREF.seen, '') === '1';
    const body = document.body;
    const overlay = $('boot-overlay');

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
    if (!gsap || reduced || (firstOnly && seen) || (home.style === 'hud' && getIntroMode() === 'off')) {
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
    if (home.style === 'hud') { // the reference boot choreography (ui/hud-boot.js)
      playHudBoot({ home, sfx, overlay, ready, greetIn, chimeOnly, countUp });
      return;
    }
    // calm: the cinematic ignition intro on the real core / orbits (ui/calm-intro.js)
    playCalmIntro({ home, sfx, overlay, ready, greetIn, chimeOnly });
  });
}
