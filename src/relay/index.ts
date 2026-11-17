// Adapted from block/buzz-app v1.0.4 relay/huddle.rs.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: independent REST/WS adapter and injected host codecs/signing.
import { recentHuddles } from "../discovery.js";
import type { HuddleBridge, HuddleDestination } from "../types.js";
import { createRelayHttp } from "./http.js";
import { announceRoom, createRoom, template } from "./protocol.js";
import { connectAudio } from "./socket.js";
import type { RelayOptions } from "./types.js";
export type { EventTemplate, SignedEvent, RelayIdentity, RelayAuthorization, RelaySocket, OpusCodec, RelayOptions } from "./types.js";

export function createRelayAdapter(options: RelayOptions) {
  const disposed = new AbortController();
  const lifetime = AbortSignal.any([disposed.signal, ...(options.signal ? [options.signal] : [])]);
  const http = createRelayHttp(options, lifetime);
  type Active = { id: string; abort: AbortController; opening?: Promise<void>;
    audio?: Awaited<ReturnType<typeof connectAudio>>; lease?: ReturnType<typeof setInterval>; touched: number };
  let active: Active | undefined;
  const stop = (call: Active) => {
    call.abort.abort(new Error("Huddle connection cancelled."));
    clearInterval(call.lease);
    call.audio?.close();
    if (active === call) active = undefined;
  };
  const bridge: HuddleBridge = {
    available: true,
    open(id, destination, room, receive, signal) {
      if (active) return Promise.reject(new Error("Leave the current Huddle first."));
      const call: Active = { id, abort: new AbortController(), touched: Date.now() };
      active = call;
      const attempt = AbortSignal.any([lifetime, call.abort.signal, ...(signal ? [signal] : [])]);
      call.opening = (async () => {
        let created: string | undefined, advertised = false;
        try {
          const membership = await http.admit(destination, room, attempt);
          const selected = room ?? crypto.randomUUID();
          if (room === undefined) {
            created = selected;
            await http.publish(createRoom(selected, destination.channelId), attempt);
            attempt.throwIfAborted();
            // Once publication is attempted others may see it, even if its receipt is lost.
            advertised = true;
            await http.publish(announceRoom(selected, destination.channelId), attempt);
          }
          const evidence = await http.authorization(http.bound(attempt));
          const authorized = http.authorizedSignal(attempt, evidence);
          authorized.throwIfAborted();
          const relay = http.relay.replace(/^http/, "ws");
          const url = `${relay}/huddle/${selected}/audio`;
          const headers: Record<string, string> = {};
          if (evidence.header) headers["Nostr-Federated-Identity"] = evidence.header;
          if (!options.createSocket && evidence.header)
            throw new Error("This community needs a host socket factory for NIP-FI upgrade headers.");
          if (!options.createSocket && typeof WebSocket === "undefined")
            throw new Error("Provide a WebSocket factory for this host.");
          const socket = options.createSocket ? options.createSocket(url, headers) : new WebSocket(url);
          call.audio = await connectAudio({ socket, identity: http.identity, relay, parent: destination.channelId,
            signal: authorized, createCodec: options.createCodec,
            receive(update) {
              if (active !== call || attempt.aborted) return;
              if (update.type === "ended") { stop(call); }
              receive(update);
            },
          });
          authorized.throwIfAborted();
          if (room !== undefined && !membership.roomMember) {
            await http.publish(template(9000, [["h", selected], ["p", http.identity.pubkey]]), authorized);
            if (!(await http.admit(destination, selected, authorized)).roomMember)
              throw new Error("Huddle chat membership could not be confirmed.");
          }
          authorized.throwIfAborted();
          call.touched = Date.now();
          call.lease = setInterval(() => {
            if (Date.now() - call.touched > 20000) {
              stop(call);
              receive({ type: "ended", error: "Huddle client heartbeat expired." });
            }
          }, 1000);
          receive({ type: "connected", room: selected, participants: call.audio.participants() });
        } catch (error) {
          stop(call);
          if (created && !advertised && !lifetime.aborted) {
            try { await http.publish(template(9002, [["h", created], ["archived", "true"]])); }
            catch { throw new Error("Huddle creation failed and cleanup was not confirmed; the temporary room will expire."); }
          }
          throw error;
        }
      })();
      return call.opening;
    },
    async close(id) {
      const call = active;
      if (!call || call.id !== id) return;
      stop(call);
      await call.opening?.catch(() => {});
      call.audio?.close();
    },
    async touch(id) {
      lifetime.throwIfAborted();
      if (!active || active.id !== id) throw new Error("Huddle connection is no longer active.");
      active.touched = Date.now();
    },
    async send(id, samples) {
      if (!active || active.id !== id || !active.audio) throw new Error("Huddle connection is not ready.");
      await active.audio.send(samples);
    },
  };
  return {
    signal: lifetime,
    bridge,
    async authorize(destination: HuddleDestination, room: string | undefined, signal: AbortSignal) {
      await http.admit(destination, room, signal);
    },
    async discover(destination: HuddleDestination, signal: AbortSignal) {
      http.validate(destination);
      const events = await http.read([
        { kinds: [48100], "#h": [destination.channelId], limit: 30 },
        { kinds: [48103], "#h": [destination.channelId], limit: 100 },
      ], signal);
      return recentHuddles(events, destination.channelId, options.relayPubkey);
    },
    async dispose() {
      const call = active;
      disposed.abort(new Error("Relay adapter disposed."));
      if (call) { stop(call); await call.opening?.catch(() => {}); call.audio?.close(); }
    },
  };
}
export type RelayAdapter = ReturnType<typeof createRelayAdapter>;
