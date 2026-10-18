// AudioWorklet for hands-free mode. Resamples the mic to 16 kHz (when the
// context runs at another rate) and posts 1280-sample (80 ms) frames straight
// to the wake Web Worker through a MessagePort, so audio never touches the UI
// thread. The UI only gets one RMS level per frame on this.port.
const OUT_RATE = 16000;
const FRAME = 1280;

class HfCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.pos = 0; // fractional read position into the incoming stream
    this.prev = 0; // last input sample (for interpolation across blocks)
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    this.worker = null;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.worker = e.data.port;
    };
  }

  _push(v) {
    this.buf[this.n++] = v;
    if (this.n === FRAME) {
      let s = 0;
      for (let i = 0; i < FRAME; i++) s += this.buf[i] * this.buf[i];
      this.port.postMessage(Math.sqrt(s / FRAME));
      if (this.worker) {
        const f = this.buf;
        this.worker.postMessage(f, [f.buffer]);
        this.buf = new Float32Array(FRAME);
      }
      this.n = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this._push(ch[i]);
      return true;
    }
    // linear resampling: walk the input at `ratio` samples per output sample
    while (this.pos < ch.length) {
      const i0 = Math.floor(this.pos);
      const t = this.pos - i0;
      const a = i0 === 0 ? this.prev : ch[i0 - 1];
      const b = ch[i0];
      this._push(a + (b - a) * t);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor('hf-capture', HfCapture);
