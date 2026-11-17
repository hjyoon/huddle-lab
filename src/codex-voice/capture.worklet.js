// Adapted from Buzz v1.0.4 audio capture. Copyright 2026 Block, Inc.
// Apache-2.0; see LICENSE and NOTICE. Modified: response generation fence.
class CodexHuddleCapture extends AudioWorkletProcessor {
  frame = new Float32Array(960);
  offset = 0;
  generation = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      this.generation = data; this.offset = 0; this.frame = new Float32Array(960);
    };
  }
  process(inputs) {
    for (const value of inputs[0]?.[0] ?? []) {
      this.frame[this.offset++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      if (this.offset === 960) {
        this.port.postMessage({ generation: this.generation, samples: this.frame });
        this.frame = new Float32Array(960); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("codex-huddle-capture", CodexHuddleCapture);
