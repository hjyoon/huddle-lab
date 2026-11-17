// Local protocol fixture, not a production relay. Keys are ephemeral and never
// written to disk. HTTP and audio authentication use actual BIP-340 signatures.
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { schnorr } from "@noble/curves/secp256k1.js";
import { serveDemoFile } from "../../scripts/serve-demo.mjs";

export const parent = "00000000-0000-4000-8000-000000000001";
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const tag = (event, name) => event.tags.find(([key]) => key === name)?.[1];
export function keypair() {
  const secret = randomBytes(32), pubkey = hex(schnorr.getPublicKey(secret));
  return {
    pubkey,
    async signEvent(template) {
      const event = { ...JSON.parse(JSON.stringify(template)), pubkey };
      event.id = digest(JSON.stringify([0, pubkey, event.created_at, event.kind, event.tags, event.content]));
      event.sig = hex(schnorr.sign(Buffer.from(event.id, "hex"), secret));
      return event;
    },
  };
}
function verify(event) {
  try {
    return digest(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])) === event.id &&
      schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"));
  } catch { return false; }
}
export async function localRelay({ identities = [keypair(), keypair()], requireFi = false, demo = false, port = 0 } = {}) {
  const authority = keypair(), rooms = new Map(), events = [], requests = [], sockets = new Map();
  const state = { identities, authority, rooms, events, requests, sockets, wrongReceiptKind: 0, tamperQuery: false,
    denyAudio: false, omitProof: false, omitConfirmation: false, receivedAudio: 0, forwardedAudio: 0 };
  const members = new Set(identities.map((identity) => identity.pubkey));
  const sign = (kind, tags, content = "") => authority.signEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) });
  const json = (response, status, body) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  let url;
  const server = createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url, url);
      if (demo && request.method === "GET" && parsed.pathname === "/local-config") {
        json(response, 200, { relayUrl: url, relayPubkey: authority.pubkey, scope: "local-relay-demo", parent,
          viewers: identities.map((identity) => identity.pubkey) });
        return;
      }
      if (request.method !== "POST") { await serveDemoFile(request, response); return; }
      if (request.headers["content-type"] !== "application/json") { json(response, 415, {}); return; }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("oversized request");
      }
      const value = JSON.parse(body);
      if (demo && parsed.pathname === "/local-sign") {
        const identity = identities[value.peer], event = value.event;
        const allowed = identity && event && [27235, 22242, 9007, 9000, 9002, 48100].includes(event.kind);
        const local = event?.kind === 27235 ? [`${url}/query`, `${url}/events`].includes(tag(event, "u")) :
          event?.kind === 22242 ? tag(event, "relay") === url.replace(/^http/, "ws") : true;
        if (!allowed || !local) { json(response, 403, {}); return; }
        json(response, 200, await identity.signEvent(event));
        return;
      }
      if (requireFi && request.headers["nostr-federated-identity"] !== "local-test-evidence") { json(response, 403, {}); return; }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Nostr ")) { json(response, 401, {}); return; }
      const auth = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString());
      if (!verify(auth) || auth.kind !== 27235 || tag(auth, "u") !== `${url}${parsed.pathname}` ||
        tag(auth, "method") !== "POST" || tag(auth, "payload") !== digest(body) ||
        Math.abs(auth.created_at - Date.now() / 1000) > 60) { json(response, 401, {}); return; }
      requests.push({ path: parsed.pathname, pubkey: auth.pubkey, value });
      if (parsed.pathname === "/query") {
        const records = [...events];
        const entries = [[parent, { creator: identities[0].pubkey, members, archived: false }], ...rooms];
        for (const [id, room] of entries) {
          records.push(await sign(39000, [["d", id], ["P", room.creator], ["archived", String(room.archived)]]));
          records.push(await sign(39002, [["d", id], ...[...room.members].map((pubkey) => ["p", pubkey])]));
        }
        const selected = new Map();
        for (const filter of value) {
          const found = records.filter((event) => filter.kinds.includes(event.kind) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#d"] || filter["#d"].includes(tag(event, "d"))) &&
            (!filter["#h"] || filter["#h"].includes(tag(event, "h"))) && !(state.omitProof && event.kind === 9007));
          for (const event of found.slice(-filter.limit)) selected.set(event.id, event);
        }
        const output = [...selected.values()];
        if (state.tamperQuery && output.length) output[0] = { ...output[0], content: "forged" };
        json(response, 200, output);
      } else if (parsed.pathname === "/events") {
        if (!verify(value) || value.pubkey !== auth.pubkey) { json(response, 403, {}); return; }
        const id = tag(value, "h");
        if (value.kind === 9007) {
          if (!members.has(value.pubkey)) { json(response, 403, {}); return; }
          rooms.set(id, { creator: value.pubkey, parent, members: new Set([value.pubkey]), archived: false });
        } else if (value.kind === 9000) {
          if (state.omitConfirmation) rooms.get(id)?.members.delete(value.pubkey);
        } else if (value.kind === 9002) {
          const room = rooms.get(id);
          if (room?.creator !== value.pubkey) { json(response, 403, {}); return; }
          room.archived = true;
        } else if (value.kind !== 48100) { json(response, 400, {}); return; }
        events.push(value);
        json(response, 200, { accepted: true, event_id: state.wrongReceiptKind === value.kind ? "0".repeat(64) : value.id });
      } else json(response, 404, {});
    } catch { if (!response.headersSent) json(response, 400, {}); else response.end(); }
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (request, socket, head) => {
    const id = /^\/huddle\/([0-9a-f-]{36})\/audio$/.exec(new URL(request.url, url).pathname)?.[1];
    if (!rooms.has(id) || (requireFi && request.headers["nostr-federated-identity"] !== "local-test-evidence")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, id));
  });
  websocket.on("connection", (client, id) => {
    const challenge = randomUUID(), room = rooms.get(id);
    client.send(JSON.stringify({ type: "challenge", challenge }));
    client.on("error", () => {});
    client.on("message", (data, binary) => {
      if (!sockets.has(client)) {
        try {
          const auth = JSON.parse(data.toString()), event = auth.event;
          if (binary || auth.type !== "auth" || auth.protocol_version !== 2 || auth.parent_channel_id !== parent ||
            !verify(event) || event.kind !== 22242 || tag(event, "relay") !== url.replace(/^http/, "ws") ||
            tag(event, "challenge") !== challenge || room.archived || state.denyAudio ||
            !(members.has(event.pubkey) || room.members.has(event.pubkey))) throw new Error("denied");
          const used = new Set([...sockets.values()].filter((peer) => peer.room === id).map((peer) => peer.peer_index));
          const index = Array.from({ length: 256 }, (_, i) => i).find((i) => !used.has(i));
          if (index === undefined) throw new Error("full");
          const peer = { room: id, pubkey: event.pubkey, peer_index: index };
          sockets.set(client, peer); room.members.add(event.pubkey);
          const peers = [...sockets.values()].filter((peer) => peer.room === id);
          client.send(JSON.stringify({ type: "joined", peer_index: index, peers }));
          for (const [other, otherPeer] of sockets) if (other !== client && otherPeer.room === id)
            other.send(JSON.stringify({ type: "joined", peers: [peer] }));
        } catch { client.send(JSON.stringify({ type: "error", message: "admission denied" })); client.close(); }
        return;
      }
      if (!binary || data.length < 9 || data.length > 4008) return;
      state.receivedAudio++;
      const peer = sockets.get(client);
      for (const [other, otherPeer] of sockets) if (other !== client && otherPeer.room === id && other.readyState === WebSocket.OPEN) {
        other.send(Buffer.concat([Buffer.from([peer.peer_index]), data])); state.forwardedAudio++;
      }
    });
    client.on("close", () => {
      const peer = sockets.get(client);
      sockets.delete(client);
      if (peer) for (const [other, otherPeer] of sockets) if (otherPeer.room === id && other.readyState === WebSocket.OPEN)
        other.send(JSON.stringify({ type: "left", peer_index: peer.peer_index }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { ...state, state, url, parent, members, identity: identities[0],
    destination(identity = identities[0]) {
      return { scope: "local-relay-demo", viewer: identity.pubkey, relayUrl: url, channelId: parent, channelName: "Local Relay" };
    },
    async close() {
      for (const client of websocket.clients) client.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
