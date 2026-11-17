/** Small energy gate for the local STT pipeline. Device echo cancellation is
 * provided by openWebAudio; this is not a neural/noise-robust speech detector. */
export function createSpeechGate(options: {
  start(): void;
  frame(samples: readonly number[]): void;
  end(valid: boolean): void;
  startRms?: number;
  endRms?: number;
  silenceFrames?: number;
  maxFrames?: number;
}) {
  let active = false, attack = 0, silence = 0, voiced = 0, count = 0, cooling = false;
  const preroll: (readonly number[])[] = [];
  const silenceFrames = options.silenceFrames ?? 35;
  const finish = () => {
    if (!active) return;
    active = false; attack = silence = count = 0; preroll.length = 0;
    options.end(voiced >= 5); voiced = 0;
  };
  return {
    input(samples: readonly number[]) {
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const loud = rms >= (options.startRms ?? 0.012), quiet = rms < (options.endRms ?? 0.008);
      if (cooling) {
        silence = quiet ? silence + 1 : 0;
        if (silence >= silenceFrames) { cooling = false; silence = 0; }
        return;
      }
      if (!active) {
        preroll.push(samples); if (preroll.length > 10) preroll.shift();
        attack = loud ? attack + 1 : 0;
        if (attack < 3) return;
        active = true; voiced = attack; count = preroll.length; silence = 0;
        options.start();
        for (const frame of preroll) options.frame(frame);
        preroll.length = 0;
        return;
      }
      options.frame(samples); count++;
      if (loud) voiced++;
      silence = quiet ? silence + 1 : 0;
      if (count >= (options.maxFrames ?? 1500)) { finish(); cooling = true; }
      else if (silence >= silenceFrames) finish();
    },
    flush: finish,
    close() { active = cooling = false; attack = silence = voiced = count = 0; preroll.length = 0; },
  };
}
