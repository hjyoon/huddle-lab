// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: host-independent contracts, without Tauri or Buzz session imports.

/** Payload only. Hosts must verify signatures before supplying remote events. */
export type LifecycleEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;

export type HuddleDiscoverySource = {
  relayAuthor: string | undefined;
  read(
    filters: readonly { kinds: readonly number[]; "#h": readonly string[]; limit: number }[],
    options: { signal: AbortSignal; priority: "foreground"; fresh: true },
  ): Promise<readonly LifecycleEvent[]>;
};

export type HuddleDestination = Readonly<{
  scope: string;
  viewer: string;
  relayUrl: string;
  channelId: string;
  channelName: string;
}>;

export type HuddleUpdate =
  | { type: "connected"; room: string; participants: readonly string[] }
  | { type: "participants"; participants: readonly string[] }
  | { type: "audio"; peer: string; samples: number[] }
  | { type: "ended"; error: string | null };

/** Trusted host boundary: open must authenticate and check current room access.
 * It may resolve before emitting connected, but must eventually settle even on
 * failure so leave/dispose can finish. close must tolerate unknown IDs.
 * send accepts 48 kHz mono PCM (960 finite samples per 20 ms frame). */
export type HuddleBridge = {
  available: boolean;
  open(
    id: string,
    destination: HuddleDestination,
    room: string | undefined,
    receive: (update: HuddleUpdate) => void,
  ): Promise<void>;
  close(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  send(id: string, samples: number[]): Promise<void>;
};

export type HuddleAudio = {
  mute(muted: boolean): void;
  play(peer: string, samples: readonly number[]): void;
  participants(peers: readonly string[]): void;
  close(): void;
};

/** Must release a late microphone grant on abort, as well as active resources. */
export type OpenHuddleAudio = (
  send: (samples: number[]) => void,
  ended: () => void,
  signal: AbortSignal,
) => Promise<HuddleAudio>;
