// ARC boot (~2.2 s), centre → outward: the core ring draws in, the dial sweeps on, pills and meter fill, the
// bracket / rings / bars draw in, then the name decodes. Click / any key skips to the final state.
// Same contract as the HUD boot: `ready()` when the UI is usable, `greetIn(ms)` for the optional voice greeting.

import { sfx } from '../sfx.js';

const gsap = window.gsap;
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&';

export function playArcBoot({ home, overlay, ready, greetIn, chimeOnly }) {
  const body = document.body;
  const arc = home.arc;
  const { parts, title, dial } = arc.bootParts();
  const label = document.getElementById('state-label');
  const FINAL = 'J.A.R.V.I.S';
  let done = false;
  arc.setBooting(true);

  // ---- initial (off) state
  overlay.hidden = false;
  gsap.set(overlay, { opacity: 1 });
  for (const e of parts.draw.concat(parts.core)) gsap.set(e, { strokeDasharray: 1, strokeDashoffset: 1 });
  const fadeAll = parts.fade.concat([dial]);
  const keep = new Map(fadeAll.map((e) => [e, e.getAttribute('opacity')]));
  gsap.set(fadeAll, { opacity: 0 });
  const blocks = parts.meter;
  const blockOp = blocks.map((b) => b.getAttribute('opacity'));
  blocks.forEach((b) => b.setAttribute('opacity', '0'));
  gsap.set(title, { opacity: 0 });

  const tl = gsap.timeline({ onComplete: () => finish(false) });
  const EASE = 'cubic-bezier(.22,1,.36,1)';
  const E = gsap.parseEase ? gsap.parseEase(EASE) : 'power3.out';
  tl.call(() => sfx.introHum && sfx.introHum(2.2), null, 0);
  tl.to(overlay, { opacity: 0, duration: 0.7, ease: 'none' }, 0);
  // 1. core ring draws in
  tl.to(parts.core, { strokeDashoffset: 0, duration: 0.6, ease: E, stagger: 0.04 }, 0);
  // 2. dial sweeps on (clockwise: the ring is revealed by a rotating fade)
  tl.to(dial, { opacity: 1, duration: 0.5, ease: E }, 0.25);
  // 3. pills one by one, the meter fills bottom → top
  const pillsAll = parts.fade.filter((e) => e.tagName === 'rect' && e.getAttribute('rx') === '4' || e.tagName === 'circle');
  pillsAll.forEach((p, i) => tl.to(p, { opacity: keep.get(p) ?? 0.75, duration: 0.2, ease: E }, 0.45 + i * 0.02));
  blocks.forEach((b, j) => tl.call(() => b.setAttribute('opacity', blockOp[j]), null, 0.45 + j * 0.035));
  // 4. bracket, rings and bars draw in (40 ms stagger); the rest fades in with them
  parts.draw.forEach((e, i) => tl.to(e, { strokeDashoffset: 0, duration: 0.6, ease: E }, 0.7 + i * 0.04));
  const rest = parts.fade.filter((e) => !pillsAll.includes(e));
  rest.forEach((e, i) => tl.to(e, { opacity: keep.get(e) ?? 1, duration: 0.5, ease: E }, 0.75 + (i % 12) * 0.03));
  // 5. the name decodes
  const o = { p: 0 };
  tl.to(o, {
    p: 1, duration: 0.6, ease: 'none', onUpdate() {
      const n = Math.floor(o.p * FINAL.length);
      let s = '';
      for (let i = 0; i < FINAL.length; i++) s += i < n || FINAL[i] === '.' ? FINAL[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      title.textContent = s;
    }, onComplete() { title.textContent = FINAL; },
  }, 1.2);
  tl.to(title, { opacity: 1, duration: 0.2 }, 1.2);
  // one soft flicker on a few bars (boot only)
  parts.flick.slice(0, 3).forEach((b, i) => tl.to(b, { opacity: 0.45, duration: 0.18, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 1.0 + i * 0.25));
  tl.call(() => { sfx.ready(); greetIn(900); home.booting = false; home.applyLabel(); }, null, 1.9);
  tl.to({}, { duration: 0.01 }, 2.2);

  const skip = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (done) return;
    sfx.quiet(400);
    tl.kill();
    gsap.fromTo(overlay, { opacity: 0.4 }, { opacity: 0, duration: 0.2, ease: 'none' });
    finish(true);
  };
  addEventListener('keydown', skip, true);
  addEventListener('mousedown', skip, true);

  function finish(skipped) {
    if (done) return;
    done = true;
    removeEventListener('keydown', skip, true);
    removeEventListener('mousedown', skip, true);
    for (const e of parts.draw.concat(parts.core)) gsap.set(e, { clearProps: 'strokeDasharray,strokeDashoffset' });
    for (const e of fadeAll) { gsap.set(e, { clearProps: 'opacity' }); const k = keep.get(e); if (k != null) e.setAttribute('opacity', k); }
    blocks.forEach((b, j) => b.setAttribute('opacity', blockOp[j]));
    parts.bars.forEach((b) => { gsap.set(b, { clearProps: 'opacity' }); b.setAttribute('opacity', '0.75'); });
    gsap.set(title, { clearProps: 'opacity' });
    title.textContent = FINAL;
    arc.setBooting(false);
    if (label) label.style.opacity = '';
    setTimeout(() => { overlay.hidden = true; }, skipped ? 220 : 0);
    body.classList.remove('booting');
    home.booting = false;
    home.applyLabel();
    if (skipped) {
      sfx.fadeGroup('boot', 0.2);
      setTimeout(chimeOnly, 200);
    }
    ready();
  }
}
