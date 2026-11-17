import { mock } from "node:test";

export function audioHarness(t) {
  const node = () => ({ connect: mock.fn(), disconnect: mock.fn() });
  const track = { enabled: true, readyState: "live", onended: null };
  track.stop = mock.fn(() => { track.readyState = "ended"; });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const output = node();
  const sources = [], buffers = [], worklets = [];
  const context = {
    sampleRate: 48000, currentTime: 0, state: "running", destination: {},
    createGain: mock.fn(() => output),
    resume: mock.fn(async () => {}),
    close: mock.fn(async () => { context.state = "closed"; }),
    audioWorklet: { addModule: mock.fn(async () => {}) },
    createMediaStreamSource: mock.fn(() => { const source = node(); sources.push(source); return source; }),
    createBuffer: mock.fn((_channels, length, rate) => ({ duration: length / rate, copyToChannel: mock.fn() })),
    createBufferSource: mock.fn(() => {
      const source = { ...node(), buffer: null, onended: null, start: mock.fn(), stop: mock.fn() };
      buffers.push(source);
      return source;
    }),
  };
  const media = { getUserMedia: mock.fn(async () => stream) };
  const contexts = mock.fn(function () { return context; });
  const stub = (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  };
  stub("navigator", { mediaDevices: media });
  stub("AudioContext", contexts);
  stub("AudioWorkletNode", class {
    constructor(...args) {
      Object.assign(this, node(), {
        args, onprocessorerror: null,
        port: { onmessage: null, close: mock.fn() },
      });
      worklets.push(this);
    }
  });
  return { context, contexts, track, stream, output, sources, buffers, worklets, media, stub };
}
