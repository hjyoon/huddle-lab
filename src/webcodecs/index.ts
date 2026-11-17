import type { OpusCodec } from "../relay/types.js";

/** Optional browser codec. No media globals are accessed during import.
 * Hosts without WebCodecs can inject a native/WASM Opus codec instead. */
export async function createWebCodecsCodec(output: (packet: Uint8Array) => void, failed: (error: Error) => void): Promise<OpusCodec> {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined" || typeof AudioData === "undefined")
    throw new Error("This host needs WebCodecs Opus or an injected native/WASM codec.");
  const encoderConfig: AudioEncoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 1,
    bitrate: 32000, opus: { frameDuration: 20000 } };
  const decoderConfig: AudioDecoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
  if (!(await AudioEncoder.isConfigSupported(encoderConfig)).supported || !(await AudioDecoder.isConfigSupported(decoderConfig)).supported)
    throw new Error("This host does not support the required Opus codec configuration.");
  let closed = false, clock = 0;
  const encoder = new AudioEncoder({
    output(chunk) {
      if (closed) return;
      const packet = new Uint8Array(chunk.byteLength); chunk.copyTo(packet); output(packet);
    },
    error(error) { if (!closed) failed(error); },
  });
  encoder.configure(encoderConfig);
  const decoders = new Map<number, { decoder: AudioDecoder; chunks: Float32Array[]; clock: number; error: Error | undefined }>();
  const remove = (peer: number) => {
    const entry = decoders.get(peer);
    if (entry?.decoder.state !== "closed") entry?.decoder.close();
    decoders.delete(peer);
  };
  return {
    encode(samples) {
      if (closed) throw new Error("Opus encoder is closed.");
      if (samples.length !== 960 || samples.some((value) => !Number.isFinite(value))) throw new Error("Expected 960 finite PCM samples.");
      const data = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: 960,
        numberOfChannels: 1, timestamp: clock, data: Float32Array.from(samples).buffer });
      clock += 20000;
      try {
        encoder.encode(data);
      } finally { data.close(); }
    },
    async decode(peer, opus) {
      if (closed) throw new Error("Opus decoder is closed.");
      let entry = decoders.get(peer);
      if (!entry) {
        const chunks: Float32Array[] = [];
        const value = { decoder: undefined as unknown as AudioDecoder, chunks, clock: 0, error: undefined as Error | undefined };
        value.decoder = new AudioDecoder({
          output(data) {
            try {
              if (data.numberOfChannels !== 1 || data.sampleRate !== 48000 || data.numberOfFrames > 5760)
                throw new Error("Unexpected decoded audio format.");
              const samples = new Float32Array(data.numberOfFrames);
              data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
              chunks.push(samples);
            } catch (error) { value.error = error as Error; }
            finally { data.close(); }
          },
          error(error) { value.error = error; },
        });
        value.decoder.configure(decoderConfig);
        entry = value; decoders.set(peer, entry);
      }
      entry.chunks.length = 0;
      entry.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: entry.clock, data: Uint8Array.from(opus).buffer }));
      entry.clock += 20000;
      await entry.decoder.flush();
      if (entry.error) throw entry.error;
      const samples = new Float32Array(entry.chunks.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const chunk of entry.chunks) { samples.set(chunk, offset); offset += chunk.length; }
      return samples;
    },
    remove,
    close() {
      if (closed) return;
      closed = true;
      if (encoder.state !== "closed") encoder.close();
      for (const peer of decoders.keys()) remove(peer);
    },
  };
}
