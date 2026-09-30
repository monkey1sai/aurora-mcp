// Lossless recorder tap for the video pipeline (AudioWorkletGlobalScope).
// Connected to the app's master node (the GainNode that feeds ctx.destination); it has no outputs, so it never
// changes what the app plays. While recording it copies every rendered frame (stereo float32, interleaved) and
// posts ~85 ms chunks, each tagged with the context frame of its first sample. 'mark' messages come back with
// the context frame of the first render quantum after they arrived — exactly the quantum in which a note posted
// from the same main-thread task starts — which is how the recorder aligns audio with the captured video frames.

const CHUNK = 4096; // frames per posted chunk

class AuroraVideoTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.buf = null;
    this.n = 0;
    this.chunkStart = 0;
    this.pendingMarks = [];
    this.silentIn = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'start') {
        this.rec = true;
        this.buf = new Float32Array(CHUNK * 2);
        this.n = 0;
        this.chunkStart = -1;
        this.port.postMessage({ type: 'started', frame: currentFrame, sampleRate });
      } else if (m.type === 'stop') {
        this.flush();
        this.rec = false;
        this.port.postMessage({ type: 'stopped', frame: currentFrame });
      } else if (m.type === 'mark') {
        // answered at the start of the next process() call (= the quantum this message takes effect in)
        this.pendingMarks.push(m.id);
      } else if (m.type === 'ping') {
        this.port.postMessage({ type: 'pong', frame: currentFrame, id: m.id });
      }
    };
  }
  flush() {
    if (!this.buf || this.n === 0) return;
    const data = this.n === CHUNK ? this.buf : this.buf.slice(0, this.n * 2);
    this.port.postMessage({ type: 'data', frame: this.chunkStart, frames: this.n, data }, [data.buffer]);
    this.buf = new Float32Array(CHUNK * 2);
    this.n = 0;
    this.chunkStart = -1;
  }
  process(inputs) {
    if (this.pendingMarks.length) {
      for (const id of this.pendingMarks) this.port.postMessage({ type: 'mark', id, frame: currentFrame });
      this.pendingMarks.length = 0;
    }
    if (!this.rec) return true;
    const inp = inputs[0] || [];
    const L = inp[0], R = inp[1] || inp[0];
    const len = L ? L.length : 128;
    for (let i = 0; i < len; i++) {
      if (this.chunkStart < 0) this.chunkStart = currentFrame + i;
      const j = this.n * 2;
      this.buf[j] = L ? L[i] : 0;
      this.buf[j + 1] = R ? R[i] : 0;
      if (++this.n === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('aurora-video-tap', AuroraVideoTap);
