// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: ignore invalid PCM and make playback cleanup idempotent.
/**
 * Plays 48 kHz mono PCM frames back to back into `output`. The first frame
 * starts `lead` seconds out; after a true underrun playback re-anchors 20 ms
 * out. An incoming frame is dropped when it would start more than 200 ms
 * ahead, so a burst cannot accumulate seconds of late speech.
 */
export function createPlayout(
  context: BaseAudioContext,
  output: AudioNode,
  lead: number,
) {
  const sources = new Set<AudioBufferSourceNode>();
  let next: number | undefined;
  let closed = false;
  return {
    play(samples: readonly number[]) {
      const now = context.currentTime;
      if (closed || !samples.length || samples.length > 5760 ||
        samples.some((value) => !Number.isFinite(value)) || (next ?? 0) > now + 0.2)
        return;
      if (next === undefined) next = now + lead;
      else if (next < now) next = now + 0.02;
      const buffer = context.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(Float32Array.from(samples), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
      };
      source.start(next);
      next += buffer.duration;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
    },
  };
}
