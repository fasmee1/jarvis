// Camera + local MediaPipe face/hand detection for the HUD overlay.
// Detection results never leave this page; only an explicit snapshot is sent.

const api = window.jarvis;
const TASKS = new URL('../node_modules/@mediapipe/tasks-vision/', import.meta.url).href;
const FRAME_MS = 66; // ≈ 15 fps

export class Vision {
  constructor({ video, overlay, onError, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.stream = null;
    this.face = null;
    this.hands = null;
    this.overlayOn = true;
    this.lastRun = 0;
    this.result = { faces: [], hands: [] };
    this._loop = this._loop.bind(this);
  }

  get on() {
    return !!this.stream;
  }

  async start(deviceId = '') {
    if (this.stream) return true;
    const open = (id) => navigator.mediaDevices.getUserMedia({
      video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const codeOf = (err) => (err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'CAM_DENIED'
      : err.name === 'NotReadableError' || err.name === 'AbortError' ? 'CAM_BUSY'
      : 'CAM_NOT_FOUND');
    try {
      this.stream = await open(deviceId);
    } catch (err) {
      let code = codeOf(err);
      // The chosen camera failed (e.g. "OBS Virtual Camera" while OBS is closed, or
      // an unplugged device): fall back to any other camera that opens.
      if (deviceId && code !== 'CAM_DENIED') {
        const others = (await listDevices('videoinput')).filter((d) => d.deviceId !== deviceId);
        for (const id of ['', ...others.map((d) => d.deviceId)]) {
          try {
            this.stream = await open(id);
            const label = this.stream.getVideoTracks()[0]?.label || 'กล้องหลัก';
            this.onStatus(`กล้องที่เลือกไว้ใช้ไม่ได้ จึงเปลี่ยนไปใช้ ${label}`);
            break;
          } catch (e2) {
            code = codeOf(e2);
          }
        }
      }
      if (!this.stream) {
        this.lastError = code;
        this.onError(code, err.message);
        return false;
      }
    }
    this.lastError = null;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (this.overlayOn) this.initDetectors();
    this.raf = requestAnimationFrame(this._loop);
    return true;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  async initDetectors() {
    if (this.face || this.loading) return;
    this.loading = true;
    try {
      const st = await api.invoke('vision:status');
      if (!st.ready) {
        this.onStatus('ยังไม่มีโมเดล MediaPipe — ดาวน์โหลดได้ใน Settings › กล้อง');
        return;
      }
      const { FilesetResolver, FaceDetector, HandLandmarker } = await import(TASKS + 'vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(TASKS + 'wasm');
      const faceBuf = new Uint8Array(await api.invoke('vision:model', 'face'));
      const handBuf = new Uint8Array(await api.invoke('vision:model', 'hand'));
      const mk = async (Cls, buf, extra) => {
        try {
          return await Cls.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: buf, delegate: 'GPU' }, runningMode: 'VIDEO', ...extra });
        } catch {
          return Cls.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' }, runningMode: 'VIDEO', ...extra });
        }
      };
      this.face = await mk(FaceDetector, faceBuf, {});
      this.hands = await mk(HandLandmarker, handBuf, { numHands: 2 });
      this.onStatus('MediaPipe พร้อม (ประมวลผลในเครื่อง)');
    } catch (err) {
      this.onError('VISION_INIT', err.message);
    } finally {
      this.loading = false;
    }
  }

  _loop(ts) {
    if (!this.stream) return;
    this.raf = requestAnimationFrame(this._loop);
    if (ts - this.lastRun < FRAME_MS || this.video.readyState < 2) return;
    this.lastRun = ts;
    const v = this.video;
    if (this.overlay.width !== v.videoWidth) {
      this.overlay.width = v.videoWidth;
      this.overlay.height = v.videoHeight;
    }
    if (this.overlayOn && this.face && this.hands) {
      try {
        const f = this.face.detectForVideo(v, ts);
        const h = this.hands.detectForVideo(v, ts);
        this.result = { faces: f.detections || [], hands: h.landmarks || [] };
      } catch { /* skip frame */ }
    } else {
      this.result = { faces: [], hands: [] };
    }
    this._draw();
  }

  _brackets(ctx, x, y, w, h, color, label) {
    const k = Math.min(w, h) * 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 12;
    ctx.shadowColor = color;
    ctx.beginPath();
    for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(px + dx * k, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * k);
    }
    ctx.stroke();
    if (label) {
      // Canvas is mirrored by CSS; flip text back so it reads normally.
      ctx.save();
      ctx.scale(-1, 1);
      ctx.fillStyle = color;
      ctx.font = '600 20px Consolas, monospace';
      ctx.fillText(label, -(x + w), y - 8);
      ctx.restore();
    }
  }

  _draw() {
    const ctx = this.overlay.getContext('2d');
    const W = this.overlay.width;
    const H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    for (const d of this.result.faces) {
      const b = d.boundingBox;
      if (b) this._brackets(ctx, b.originX, b.originY, b.width, b.height, '#00e5ff', 'TARGET');
    }
    for (const lm of this.result.hands) {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      ctx.fillStyle = '#4dffa6';
      ctx.shadowBlur = 6;
      for (const p of lm) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      this._brackets(ctx, x0 * W - 12, y0 * H - 12, (x1 - x0) * W + 24, (y1 - y0) * H + 24, '#4dffa6', 'HAND');
    }
  }

  /** Actual capture size reported by the camera track. */
  trackInfo() {
    const t = this.stream && this.stream.getVideoTracks()[0];
    const st = t ? t.getSettings() : {};
    return { width: st.width || this.video.videoWidth || 0, height: st.height || this.video.videoHeight || 0, label: t ? t.label : '', deviceId: st.deviceId || '' };
  }

  /** Current frame at native size as an image Blob (for the assistant to analyze). */
  captureFrame(type = 'image/jpeg', quality = 0.9) {
    const v = this.video;
    if (!this.stream || v.readyState < 2) return Promise.resolve(null);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, type, quality));
  }

  /** Grab one frame, scaled to cover w×h, as a JPEG data URL. */
  snapshot(w = 640, h = 480, quality = 0.8) {
    const v = this.video;
    if (!this.stream || v.readyState < 2) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const s = Math.max(w / v.videoWidth, h / v.videoHeight);
    const dw = v.videoWidth * s;
    const dh = v.videoHeight * s;
    ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', quality);
  }
}

export async function listDevices(kind) {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === kind);
  } catch {
    return [];
  }
}
