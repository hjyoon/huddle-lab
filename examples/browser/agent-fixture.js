// Deterministic wiring fixture. This is NOT an AI, ASR or TTS implementation.
// The input is counted, never recorded; output is a generated test tone.
export function createTestProvider(onInput) {
  let current;
  let nextResponse = 0;
  const stopTone = (seat) => { clearInterval(seat.timer); seat.timer = undefined; };
  return {
    provider: {
      id: "test-provider", name: "테스트 제공자 (모델 미연결)",
      async open(context) {
        const seat = { context, timer: undefined };
        current = seat;
        const stop = () => stopTone(seat);
        context.signal.addEventListener("abort", stop, { once: true });
        return {
          input(samples) { if (!context.signal.aborted) onInput(samples); },
          interrupt() { stopTone(seat); },
          close() {
            stopTone(seat);
            context.signal.removeEventListener("abort", stop);
            if (current === seat) current = undefined;
          },
        };
      },
    },
    respond() {
      const seat = current;
      if (!seat || seat.context.signal.aborted) return;
      stopTone(seat);
      const responseId = `test-${++nextResponse}`;
      seat.context.emit({ type: "response-started", responseId });
      let frame = 0;
      seat.timer = setInterval(() => {
        if (seat.context.signal.aborted) { stopTone(seat); return; }
        const samples = Array.from({ length: 960 }, (_, i) =>
          Math.sin((frame * 960 + i) * 2 * Math.PI * 330 / 48000) * 0.08);
        seat.context.emit({ type: "audio", responseId, samples });
        if (++frame === 30) {
          stopTone(seat);
          seat.context.emit({ type: "transcript", id: responseId, speaker: "assistant", responseId,
            text: "연결 테스트용 합성 발화문입니다. 실제 AI 응답이나 음성 인식 결과가 아닙니다." });
          seat.context.emit({ type: "response-ended", responseId });
        }
      }, 20);
    },
  };
}
