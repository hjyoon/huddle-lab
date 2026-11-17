import { schnorr } from "@noble/curves/secp256k1.js";
import { hexKey, now, template } from "./protocol.js";
import type { EventTemplate, RelayIdentity, SignedEvent } from "./types.js";

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
export async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
export async function checkedEvent(value: unknown): Promise<SignedEvent> {
  const e = value as Record<string, unknown> | null;
  if (!e || !hexKey(e.id) || !hexKey(e.pubkey) || typeof e.sig !== "string" || !/^[0-9a-f]{128}$/.test(e.sig) ||
    !Number.isSafeInteger(e.kind) || (e.kind as number) < 0 || (e.kind as number) > 65535 ||
    !Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0 || typeof e.content !== "string" ||
    !Array.isArray(e.tags) || e.tags.some((entry) => !Array.isArray(entry) || entry.some((part) => typeof part !== "string")))
    throw new Error("Invalid signed Relay event.");
  // Copy first; caller mutations and cached-verification symbols are never proof.
  const event: SignedEvent = Object.freeze({
    id: e.id, pubkey: e.pubkey, sig: e.sig, kind: e.kind as number,
    created_at: e.created_at as number, content: e.content,
    tags: Object.freeze(e.tags.map((entry: string[]) => Object.freeze([...entry]))),
  });
  const id = await sha256(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
  if (id !== event.id || !schnorr.verify(bytes(event.sig), bytes(id), bytes(event.pubkey)))
    throw new Error("Relay event signature verification failed.");
  return event;
}
export async function signChecked(identity: RelayIdentity, event: EventTemplate) {
  const expected = JSON.stringify([event.kind, event.created_at, event.tags, event.content]);
  const signed = await checkedEvent(await identity.signEvent(JSON.parse(JSON.stringify(event))));
  if (signed.pubkey !== identity.pubkey || expected !== JSON.stringify([signed.kind, signed.created_at, signed.tags, signed.content]))
    throw new Error("Signer changed the identity or event being authorized.");
  return signed;
}
export async function httpAuthorization(identity: RelayIdentity, url: string, body: string) {
  const signed = await signChecked(identity, template(27235, [
    ["u", url], ["method", "POST"], ["payload", await sha256(body)], ["nonce", crypto.randomUUID()],
  ]));
  const encoded = new TextEncoder().encode(JSON.stringify(signed));
  return `Nostr ${btoa(Array.from(encoded, (byte) => String.fromCharCode(byte)).join(""))}`;
}
export const audioAuthorization = (identity: RelayIdentity, relay: string, challenge: string) =>
  signChecked(identity, { kind: 22242, created_at: now(), tags: [["relay", relay], ["challenge", challenge]], content: "" });

/** Abort even when a host signer/provider does not cooperate. */
export function until<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
