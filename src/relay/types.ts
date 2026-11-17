import type { LifecycleEvent } from "../types.js";

export type EventTemplate = Pick<LifecycleEvent, "kind" | "created_at" | "tags" | "content">;
export type SignedEvent = LifecycleEvent & Readonly<{ sig: string }>;
export type RelayIdentity = {
  pubkey: string;
  /** Host-owned signer. The adapter accepts no private keys and stores none. */
  signEvent(event: EventTemplate): Promise<SignedEvent>;
};
export type RelayAuthorization = {
  /** NIP-FI header from an existing host sign-in, never a query parameter. */
  header?: string;
  /** Absolute Unix milliseconds. Expiry ends the call, without automatic renewal. */
  expiresAt?: number;
  signal?: AbortSignal;
};
export type RelaySocket = Pick<WebSocket,
  "binaryType" | "bufferedAmount" | "readyState" | "send" | "close" |
  "addEventListener" | "removeEventListener">;
export type OpusCodec = {
  /** Submit a frame; output arrives via the factory callback. Codecs may need
   * lookahead, so submission must not wait for a packet from this same frame. */
  encode(samples: readonly number[]): void | Promise<void>;
  decode(peer: number, opus: Uint8Array): Promise<Float32Array>;
  remove(peer: number): void;
  close(): void;
};
export type RelayOptions = {
  relayUrl: string;
  /** Pin the community's trusted signing key; do not derive it from an HTTP reply. */
  relayPubkey: string;
  scope: string;
  identity: RelayIdentity;
  createCodec(output: (packet: Uint8Array) => void, failed: (error: Error) => void): Promise<OpusCodec>;
  fetch?: typeof fetch;
  /** Browser WebSocket cannot attach NIP-FI upgrade headers. A restricted
   * community needs a trusted native/Node socket factory that attaches them. */
  createSocket?: (url: string, headers: Readonly<Record<string, string>>) => RelaySocket;
  authorization?: (signal: AbortSignal) => Promise<RelayAuthorization>;
  signal?: AbortSignal;
};
