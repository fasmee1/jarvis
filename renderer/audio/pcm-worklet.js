// AudioWorklet: forwards mono Float32 audio in ~50 ms batches to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = Math.round(sampleRate * 0.05);
    this.buf = new Float32Array(this.batch);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.batch) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
