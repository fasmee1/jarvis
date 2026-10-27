'use strict';
// Effects a clip can have when it comes in (what you see, what you hear), as pure data and
// small generators (no I/O):
//   FX: how the picture comes in → the GSAP lines HyperFrames plays at the clip's start.
//   SFX: short sounds made by ffmpeg itself (no files to license) → the ffmpeg arguments.
// The ids are what the edit list stores; the labels are what the user reads.

const FX = Object.freeze({
  none: { id: 'none', label: 'ไม่มี' },
  fade: { id: 'fade', label: 'เฟดจากดำ', dur: 0.4 },
  flash: { id: 'flash', label: 'แฟลชขาว', dur: 0.3 },
  zoom: { id: 'zoom', label: 'ซูมเข้า', dur: 0.5 },
  slide: { id: 'slide', label: 'สไลด์เข้า', dur: 0.4 },
  blur: { id: 'blur', label: 'เบลอแล้วชัด', dur: 0.45 },
});

// how the picture goes out, at the end of a clip
const FX_OUT = Object.freeze({
  none: { id: 'none', label: 'ไม่มี' },
  fade: { id: 'fade', label: 'เฟดเป็นดำ', dur: 0.4 },
  zoom: { id: 'zoom', label: 'ซูมออกเบา ๆ', dur: 0.5 },
  slide: { id: 'slide', label: 'สไลด์ออก', dur: 0.4 },
  blur: { id: 'blur', label: 'เบลอออก', dur: 0.45 },
});

const SFX = Object.freeze({
  none: { id: 'none', label: 'ไม่มี' },
  whoosh: { id: 'whoosh', label: 'วูช', dur: 0.7, lead: 0.12 },
  pop: { id: 'pop', label: 'ป๊อป', dur: 0.2, lead: 0 },
  ding: { id: 'ding', label: 'ติ๊ง', dur: 0.9, lead: 0 },
  click: { id: 'click', label: 'คลิก', dur: 0.08, lead: 0 },
});

const r3 = (x) => Math.round(x * 1000) / 1000;

const isFx = (id) => Object.prototype.hasOwnProperty.call(FX, id);
const isFxOut = (id) => Object.prototype.hasOwnProperty.call(FX_OUT, id);
const isSfx = (id) => Object.prototype.hasOwnProperty.call(SFX, id);

/**
 * The GSAP lines for one clip coming in at timeline second `at`. `video` is the element id of
 * the clip ('m-c1'), `flash` the id of the white overlay (only used by 'flash').
 * An unknown or 'none' effect gives no lines.
 */
function fxTween(fx, { video, flash, at }) {
  const s = r3(at);
  switch (fx) {
    case 'fade':
      return [`tl.fromTo("#${video}", { opacity: 0 }, { opacity: 1, duration: ${FX.fade.dur}, ease: "power1.out" }, ${s});`];
    case 'zoom':
      return [`tl.fromTo("#${video}", { scale: 1.2 }, { scale: 1, duration: ${FX.zoom.dur}, ease: "power3.out" }, ${s});`];
    case 'slide':
      return [`tl.fromTo("#${video}", { xPercent: 14, opacity: 0 }, { xPercent: 0, opacity: 1, duration: ${FX.slide.dur}, ease: "power2.out" }, ${s});`];
    case 'blur':
      return [`tl.fromTo("#${video}", { filter: "blur(26px)" }, { filter: "blur(0px)", duration: ${FX.blur.dur}, ease: "power2.out" }, ${s});`];
    case 'flash':
      return [`tl.fromTo("#${flash}", { opacity: 0.95 }, { opacity: 0, duration: ${FX.flash.dur}, ease: "power2.out" }, ${s});`];
    default:
      return [];
  }
}

/** The GSAP lines for one clip going out, ending at timeline second `end`. */
function fxOutTween(fx, { video, end }) {
  const at = (d) => r3(Math.max(0, end - d));
  switch (fx) {
    case 'fade':
      return [`tl.to("#${video}", { opacity: 0, duration: ${FX_OUT.fade.dur}, ease: "power1.in" }, ${at(FX_OUT.fade.dur)});`];
    case 'zoom':
      return [`tl.to("#${video}", { scale: 1.15, duration: ${FX_OUT.zoom.dur}, ease: "power2.in" }, ${at(FX_OUT.zoom.dur)});`];
    case 'slide':
      return [`tl.to("#${video}", { xPercent: -14, opacity: 0, duration: ${FX_OUT.slide.dur}, ease: "power2.in" }, ${at(FX_OUT.slide.dur)});`];
    case 'blur':
      return [`tl.to("#${video}", { filter: "blur(26px)", duration: ${FX_OUT.blur.dur}, ease: "power2.in" }, ${at(FX_OUT.blur.dur)});`];
    default:
      return [];
  }
}

/** Seconds before the cut the sound should start (so its hit lands on the cut). */
function sfxLead(id) {
  return isSfx(id) && SFX[id].lead ? SFX[id].lead : 0;
}

/** ffmpeg arguments that write the sound `id` to `out` (a .wav path). Throws for unknown ids. */
function sfxArgs(id, out) {
  if (!isSfx(id) || id === 'none') throw new Error('ไม่รู้จักเสียงเอฟเฟกต์นี้');
  const src = {
    whoosh: ['-f', 'lavfi', '-i', `anoisesrc=d=${SFX.whoosh.dur}:c=pink:r=44100:a=0.9`, '-af', 'highpass=f=450,lowpass=f=5200,afade=t=in:d=0.32,afade=t=out:st=0.32:d=0.38,volume=1.2'],
    pop: ['-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*t*(900-3600*t))*exp(-16*t)*0.9:d=${SFX.pop.dur}:s=44100`],
    ding: ['-f', 'lavfi', '-i', `aevalsrc=(sin(2*PI*1320*t)+0.4*sin(2*PI*1980*t))*exp(-5*t)*0.6:d=${SFX.ding.dur}:s=44100`],
    click: ['-f', 'lavfi', '-i', `aevalsrc=(random(0)*2-1)*exp(-110*t)*0.8:d=${SFX.click.dur}:s=44100`],
  }[id];
  return ['-hide_banner', '-y', ...src, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out];
}

module.exports = { FX, FX_OUT, SFX, isFx, isFxOut, isSfx, fxTween, fxOutTween, sfxLead, sfxArgs };
