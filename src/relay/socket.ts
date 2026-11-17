// Adapted from buzz-audio-client connection.rs, wire.rs and buzz-app huddle/audio.rs.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: abortable WebSocket/WebCodecs host, fixed bounded PCM playout;
// no native NetEQ dependency. V2 cannot fence late packets after index reuse.
import type { HuddleUpdate } from "../types.js";
import { audioAuthorization, until } from "./auth.js";
import { audioLevel, encodeFrame, parseFrame, parsePeers } from "./protocol.js";
import type { Peer } from "./protocol.js";
import type { OpusCodec, RelayIdentity, RelaySocket } from "./types.js";

export async function connectAudio(options: {
  socket: RelaySocket; identity: RelayIdentity; relay: string; parent: string;
  signal: AbortSignal; createCodec(output: (packet: Uint8Array) => void, failed: (error: Error) => void): Promise<OpusCodec>;
  receive(update: HuddleUpdate): void;
}) {
  const { socket, receive } = options;
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const handshake = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  socket.binaryType = "arraybuffer";
  let closed = false, admitted = false, codec: OpusCodec | undefined;
  let sequence = 0, timestamp = 0;
  let playout: ReturnType<typeof setInterval> | undefined;
  const peers = new Map<number, Peer>();
  const levels: number[] = [];
  const media = new Map<number, { generation: Peer; sequence?: number; pending: number; queue: number[]; decoding: Promise<void> }>();
  let phase: "challenge" | "signing" | "joined" | "ready" = "challenge";
  let resolveAdmission!: () => void, rejectAdmission!: (error: unknown) => void;
  const admission = new Promise<void>((resolve, reject) => { resolveAdmission = resolve; rejectAdmission = reject; });
  // Listen before doing any awaited codec or signing work: fast relays may already speak.
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(playout);
    signal.removeEventListener("abort", abort);
    socket.removeEventListener("message", onMessage);
    if (socket.readyState === 3) {
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    }
    media.clear(); peers.clear(); levels.length = 0;
    stop.abort(new Error("Huddle audio closed."));
    codec?.close();
    socket.close();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    const wasAdmitted = admitted;
    close();
    rejectAdmission(error);
    if (wasAdmitted) receive({ type: "ended", error: error instanceof Error ? error.message : "Huddle audio disconnected." });
  };
  const abort = () => fail(signal.reason ?? new Error("Huddle authorization ended."));
  const onClose = () => {
    if (closed) {
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    } else fail(new Error("Huddle audio disconnected. Join again to retry."));
  };
  const onError = () => fail(new Error("Huddle audio connection failed."));
  function roster(next: readonly Peer[], replace: boolean) {
    const updated = replace ? new Map<number, Peer>() : new Map(peers);
    for (const peer of next) updated.set(peer.index, peer);
    for (const [index, peer] of peers) {
      const other = updated.get(index);
      if (!other || peer.pubkey !== other.pubkey || peer.epoch !== other.epoch) {
        media.delete(index); codec?.remove(index);
      }
    }
    peers.clear();
    for (const [index, peer] of updated) peers.set(index, peer);
    if (admitted) receive({ type: "participants", participants: [...peers.values()].map((peer) => peer.pubkey) });
  }
  async function control(value: Record<string, unknown>) {
    if (value.type === "error") throw new Error("The relay refused or ended this Huddle connection.");
    if (phase === "challenge") {
      if (value.type !== "challenge" || typeof value.challenge !== "string" || !value.challenge || value.challenge.length > 4096)
        throw new Error("Invalid Huddle challenge.");
      phase = "signing";
      const event = await until(audioAuthorization(options.identity, options.relay, value.challenge), handshake);
      if (closed) return;
      phase = "joined";
      socket.send(JSON.stringify({ type: "auth", event, parent_channel_id: options.parent, protocol_version: 2 }));
      return;
    }
    if (phase === "joined") {
      if (value.type !== "joined" || !Number.isInteger(value.peer_index) || (value.peer_index as number) < 0 || (value.peer_index as number) > 255)
        throw new Error("Huddle admission was not confirmed.");
      roster(parsePeers(value), true);
      phase = "ready";
      resolveAdmission();
      return;
    }
    if (phase !== "ready") throw new Error("Unexpected Huddle handshake message.");
    if (value.type === "joined" || value.type === "roster") roster(parsePeers(value), value.type === "roster");
    else if (value.type === "left") {
      if (!Number.isInteger(value.peer_index) || (value.peer_index as number) < 0 || (value.peer_index as number) > 255)
        throw new Error("Invalid Huddle leave message.");
      roster([...peers.values()].filter((peer) => peer.index !== value.peer_index), true);
    }
  }
  function binary(bytes: Uint8Array) {
    if (!admitted || !codec) return;
    const frame = parseFrame(bytes), peer = frame && peers.get(frame.index);
    if (!frame || !peer) return;
    let state = media.get(peer.index);
    if (!state) {
      state = { generation: peer, pending: 0, queue: [], decoding: Promise.resolve() };
      media.set(peer.index, state);
    }
    const delta = state.sequence === undefined ? 1 : (frame.sequence - state.sequence + 65536) % 65536;
    if (delta === 0 || delta >= 32768 || state.pending >= 5) return;
    state.sequence = frame.sequence;
    state.pending++;
    const target = state, decoder = codec;
    state.decoding = state.decoding.then(async () => {
      if (closed || media.get(peer.index) !== target) return;
      const samples = await decoder.decode(peer.index, frame.opus);
      if (closed || media.get(peer.index) !== target || !samples.length || samples.length > 5760 || samples.some((n) => !Number.isFinite(n))) return;
      target.queue.push(...samples);
      // Keep at most 200ms of decoded media per device; discard stale speech.
      if (target.queue.length > 9600) target.queue.splice(0, target.queue.length - 9600);
    }).catch(() => {
      if (media.get(peer.index) === target) { decoder.remove(peer.index); target.queue.length = 0; }
    })
      .finally(() => { target.pending--; });
  }
  function onMessage(event: MessageEvent) {
    if (closed) return;
    if (typeof event.data === "string") {
      if (event.data.length > 65536) { fail(new Error("Huddle control message too large.")); return; }
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Huddle control message.");
        void control(value as Record<string, unknown>).catch(fail);
      } catch (error) { fail(error); }
    } else if (event.data instanceof ArrayBuffer) binary(new Uint8Array(event.data));
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await until(admission, handshake);
    signal.throwIfAborted();
    const opening = options.createCodec((opus) => {
      if (closed) return;
      const level = levels.shift();
      if (level === undefined) { fail(new Error("Unexpected Opus encoder output.")); return; }
      if (socket.bufferedAmount > 5 * 4008) return;
      try {
        socket.send(encodeFrame(opus, sequence, timestamp, level));
        sequence = (sequence + 1) & 65535;
        timestamp = (timestamp + 960) >>> 0;
      } catch (error) { fail(error); }
    }, fail);
    // A late codec must not survive a cancelled admission.
    void opening.then((value) => { if (closed) value.close(); }, () => {});
    codec = await until(opening, handshake);
    signal.throwIfAborted();
    admitted = true;
    playout = setInterval(() => {
      const mixed = new Map<string, number[]>();
      for (const [index, state] of media) {
        const peer = peers.get(index);
        if (!peer || !state.queue.length) continue;
        const chunk = state.queue.splice(0, 480);
        const output = mixed.get(peer.pubkey) ?? new Array<number>(480).fill(0);
        for (let i = 0; i < chunk.length; i++) output[i] = output[i]! + chunk[i]!;
        mixed.set(peer.pubkey, output);
      }
      for (const [peer, samples] of mixed) receive({ type: "audio", peer, samples: samples.map((value) => Math.max(-1, Math.min(1, value))) });
    }, 10);
    return {
      participants: () => [...peers.values()].map((peer) => peer.pubkey),
      close,
      async send(samples: readonly number[]) {
        if (closed || !codec) throw new Error("Huddle audio is closed.");
        if (samples.length !== 960 || samples.some((n) => !Number.isFinite(n))) throw new Error("Expected 960 finite PCM samples.");
        if (socket.bufferedAmount > 5 * 4008 || levels.length >= 5) return;
        levels.push(audioLevel(samples));
        try { await codec.encode(samples); }
        catch (error) { fail(error); throw error; }
      },
    };
  } catch (error) { close(); throw error; }
}
