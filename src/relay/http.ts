// Adapted from block/buzz-app v1.0.4 relay.rs and relay/huddle.rs.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: pinned authority, injected signer/fetch and bounded TypeScript REST.
import type { HuddleDestination } from "../types.js";
import { huddleParent } from "../lifecycle.js";
import { checkedEvent, httpAuthorization, signChecked, until } from "./auth.js";
import { hexKey, latest, origin, tag, uuid } from "./protocol.js";
import type { EventTemplate, RelayAuthorization, RelayOptions, SignedEvent } from "./types.js";

export type Filter = { kinds: readonly number[]; authors?: readonly string[]; limit: number;
  "#d"?: readonly string[]; "#h"?: readonly string[]; consistency?: "strong" };
export function createRelayHttp(options: RelayOptions, lifetime: AbortSignal) {
  const relay = origin(options.relayUrl);
  const pubkey = options.identity.pubkey;
  if (!hexKey(pubkey) || !hexKey(options.relayPubkey) || !options.scope)
    throw new Error("Relay authority, viewer key and session scope are required.");
  const identity = { pubkey, signEvent: options.identity.signEvent.bind(options.identity) };
  const bound = (signal?: AbortSignal, timeout = 15000) => AbortSignal.any([
    lifetime, ...(signal ? [signal] : []), AbortSignal.timeout(timeout),
  ]);
  const validate = (destination: HuddleDestination, room?: string) => {
    if (origin(destination.relayUrl) !== relay || destination.viewer !== pubkey ||
      destination.scope !== options.scope || !uuid(destination.channelId) ||
      (room !== undefined && (!uuid(room) || room === destination.channelId)))
      throw new Error("Huddle destination does not match this Relay identity and session.");
    lifetime.throwIfAborted();
  };
  async function authorization(signal: AbortSignal): Promise<RelayAuthorization> {
    signal.throwIfAborted();
    const value = options.authorization ? await until(options.authorization(signal), signal) : {};
    signal.throwIfAborted();
    if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()))
      throw new Error("Huddle authorization expired. Join again after signing in.");
    value.signal?.throwIfAborted();
    if (value.header !== undefined && (!value.header || value.header.length > 8192 || /[\r\n]/.test(value.header)))
      throw new Error("Invalid federated authorization header.");
    return value;
  }
  function authorizedSignal(signal: AbortSignal, evidence: RelayAuthorization) {
    return AbortSignal.any([signal, ...(evidence.signal ? [evidence.signal] : []),
      ...(evidence.expiresAt === undefined ? [] : [AbortSignal.timeout(Math.min(2147483647, Math.max(0, Math.floor(evidence.expiresAt - Date.now()))))]),
    ]);
  }
  async function request(path: "/query" | "/events", value: unknown, signal?: AbortSignal) {
    const limit = bound(signal), evidence = await authorization(limit);
    const active = authorizedSignal(limit, evidence);
    active.throwIfAborted();
    const body = JSON.stringify(value), url = `${relay}${path}`;
    const auth = await until(httpAuthorization(identity, url, body), active);
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: auth };
    if (evidence.header) headers["Nostr-Federated-Identity"] = evidence.header;
    const response = await until((options.fetch ?? fetch)(url, {
      method: "POST", headers, body, signal: active, redirect: "error", credentials: "omit",
    }), active);
    // Bound streamed bodies too; Content-Length is not a trusted allocation limit.
    const reader = response.body?.getReader();
    let text = "", size = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await until(reader.read(), active);
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) throw new Error("Relay response exceeded the size limit.");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
    }
    if (!response.ok) throw new Error(`Relay request rejected (HTTP ${response.status}).`);
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("Invalid Relay JSON response."); }
  }
  async function read(filters: readonly Filter[], signal?: AbortSignal) {
    const value = await request("/query", filters, signal);
    if (!Array.isArray(value)) throw new Error("Invalid Relay event list.");
    return Promise.all(value.map(checkedEvent));
  }
  async function publish(event: EventTemplate, signal?: AbortSignal) {
    const active = bound(signal);
    active.throwIfAborted();
    const signed = await until(signChecked(identity, event), active);
    const receipt = await request("/events", signed, active) as Record<string, unknown> | null;
    if (!receipt || receipt.accepted !== true || receipt.event_id !== signed.id)
      throw new Error("Relay did not acknowledge the exact published event.");
  }
  async function admit(destination: HuddleDestination, room: string | undefined, signal?: AbortSignal) {
    validate(destination, room);
    const ids = room ? [destination.channelId, room] : [destination.channelId];
    const records = await read(ids.map((id) => ({ kinds: [39000, 39002], authors: [options.relayPubkey],
      "#d": [id], limit: 2, consistency: "strong" })), signal);
    const membership = (id: string) => {
      const metadata = latest(records, 39000, id, options.relayPubkey);
      const roster = latest(records, 39002, id, options.relayPubkey);
      if (metadata && tag(metadata, "archived") === "true") throw new Error("Huddle channel is archived.");
      return { metadata, member: !!metadata && !!roster?.tags.some(([key, value]) => key === "p" && value === pubkey) };
    };
    const parent = membership(destination.channelId);
    const invited = room ? membership(room) : undefined;
    if (!parent.member && !invited?.member) throw new Error("You must belong to this Huddle or its original chat to join.");
    if (!parent.member && invited?.metadata && room) {
      const creator = tag(invited.metadata, "P");
      if (!hexKey(creator)) throw new Error("Huddle creator proof is unavailable.");
      const receipts = await read([{ kinds: [9007], authors: [creator], "#h": [room], limit: 2, consistency: "strong" }], signal);
      const proof = receipts.some((event) => event.kind === 9007 && event.pubkey === creator &&
        tag(event, "h") === room && tag(event, "visibility") === "private" && tag(event, "channel_type") === "stream" &&
        huddleParent(tag(event, "about")) === destination.channelId);
      if (!proof) throw new Error("Could not verify the Huddle's original conversation.");
    }
    return { roomMember: invited?.member ?? false, parentMember: parent.member };
  }
  return { relay, identity, bound, validate, authorization, authorizedSignal, read, publish, admit };
}
