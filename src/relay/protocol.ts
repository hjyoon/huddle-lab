// Adapted from block/buzz-app v1.0.4 relay/huddle.rs and block/buzz
// 630922a9e1f891380a61f5b7d726d05ca948cc64 buzz-audio-client wire.rs.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: TypeScript event construction, roster validation and v2 framing.
import { huddleDescription } from "../lifecycle.js";
import type { EventTemplate, SignedEvent } from "./types.js";

export const hexKey = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const tag = (event: SignedEvent, name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
export const now = () => Math.floor(Date.now() / 1000);
export function origin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Relay must be an HTTPS origin (HTTP is allowed only on loopback).");
  return url.origin;
}
export const template = (kind: number, tags: readonly (readonly string[])[], content = ""): EventTemplate =>
  ({ kind, tags, content, created_at: now() });
export const createRoom = (room: string, parent: string) => template(9007, [
  ["h", room], ["name", "Huddle"], ["visibility", "private"], ["channel_type", "stream"],
  ["about", huddleDescription(parent)], ["ttl", "3600"],
]);
export const announceRoom = (room: string, parent: string) =>
  template(48100, [["h", parent]], JSON.stringify({ ephemeral_channel_id: room }));
export function latest(events: readonly SignedEvent[], kind: number, id: string, author: string) {
  return events.filter((event) => event.kind === kind && event.pubkey === author && tag(event, "d") === id)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}
export type Peer = { index: number; pubkey: string; epoch: number };
export function parsePeers(value: Record<string, unknown>): Peer[] {
  if (!Array.isArray(value.peers) || value.peers.length > 256) throw new Error("Invalid Huddle roster.");
  const seen = new Set<number>();
  return value.peers.map((entry: unknown) => {
    const p = entry as Record<string, unknown> | null;
    const index = p?.peer_index, epoch = p?.epoch ?? 0;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 255 ||
      !Number.isInteger(epoch) || (epoch as number) < 0 || (epoch as number) > 255 ||
      !hexKey(p?.pubkey) || seen.has(index as number)) throw new Error("Invalid Huddle peer.");
    seen.add(index as number);
    return { index: index as number, pubkey: p.pubkey, epoch: epoch as number };
  });
}
export function audioLevel(samples: readonly number[]) {
  const mean = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
  return mean > 0 ? Math.max(-127, Math.min(0, Math.round(10 * Math.log10(mean)))) : -127;
}
export function encodeFrame(opus: Uint8Array, sequence: number, timestamp: number, level: number) {
  if (!opus.length || opus.length > 4000) throw new Error("Invalid Opus payload.");
  const frame = new Uint8Array(8 + opus.length), view = new DataView(frame.buffer);
  view.setUint16(0, sequence & 65535);
  view.setUint32(2, timestamp >>> 0);
  view.setInt8(6, level);
  frame[7] = opus.length <= 2 ? 1 : 0;
  frame.set(opus, 8);
  return frame;
}
export function parseFrame(bytes: Uint8Array) {
  if (bytes.length < 10 || bytes.length > 4009) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { index: bytes[0]!, sequence: view.getUint16(1), timestamp: view.getUint32(3), opus: bytes.slice(9) };
}
