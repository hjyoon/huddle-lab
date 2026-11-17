// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: detached from Buzz application types; runtime behavior preserved.
/** Serial PCM delivery shared by microphones and agent voices. Keep the newest
 * four waiting 20 ms frames (80 ms), plus one in flight. This bounds retained
 * media, not time spent waiting for IPC. Already submitted frames cannot be
 * recalled; clear() discards only those still waiting, without ending the call. */
export function createPcmSender(
  send: (samples: number[]) => Promise<void>,
  signal: AbortSignal,
  failed: (error: unknown) => void,
) {
  const pending: number[][] = [];
  let sending = false;
  let broken = false;
  const clear = () => {
    pending.length = 0;
  };
  signal.addEventListener("abort", clear, { once: true });
  return {
    clear,
    async send(samples: number[]) {
      if (signal.aborted || broken) return;
      if (pending.length === 4) pending.shift();
      pending.push(samples);
      if (sending) return;
      sending = true;
      try {
        while (!signal.aborted && pending.length) {
          const frame = pending.shift();
          if (frame) await send(frame);
        }
      } catch (error) {
        broken = true;
        clear();
        if (!signal.aborted) failed(error);
      } finally {
        sending = false;
      }
    },
  };
}
