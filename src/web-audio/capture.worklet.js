// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: replace non-finite input samples with silence.
// A fixed 20ms/48kHz mono frame matches the existing Huddle v2 Opus sender.
class HuddleCapture extends AudioWorkletProcessor {
  frame = new Float32Array(960);
  offset = 0;
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (const value of input) {
        this.frame[this.offset++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame);
          this.frame = new Float32Array(960);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("buzz-huddle-capture", HuddleCapture);
