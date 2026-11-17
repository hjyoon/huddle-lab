import type { OpenHuddleAudio } from "../types.js";

export type AgentActivity = "idle" | "listening" | "thinking" | "speaking";
export type AgentTranscript = Readonly<{
  id: string;
  speaker: "user" | "assistant";
  text: string;
  responseId?: string;
}>;
export type AgentVoiceEvent =
  | { type: "activity"; activity: "listening" | "thinking" }
  | { type: "response-started"; responseId: string }
  | { type: "audio"; responseId: string; samples: readonly number[] }
  | { type: "response-ended"; responseId: string }
  | { type: "response-interrupted"; responseId: string }
  | ({ type: "transcript" } & AgentTranscript)
  | { type: "ended"; error?: string };

/** A media pipe only. Tool authority, credentials, speech detection and
 * inference belong to the provider. Emit final transcripts, not ASR partials. */
export type AgentVoiceContext = Readonly<{
  id: string;
  signal: AbortSignal;
  emit(event: AgentVoiceEvent): void;
}>;
export type AgentVoiceConnection = {
  /** 48 kHz mono normalized PCM. The direct Huddle supplies 960 samples/frame. */
  input(samples: readonly number[]): void | Promise<void>;
  /** Cancel both the identified response and any pending inference. */
  interrupt(responseId: string | undefined): void | Promise<void>;
  /** Idempotent; settle all provider work and release media before resolving. */
  close(): void | Promise<void>;
};
export type AgentVoiceProvider = Readonly<{
  id: string;
  name: string;
  /** Must observe context.signal and settle on abort. An opening seat stays
   * reserved until this resolves/rejects and its connection finishes closing. */
  open(context: AgentVoiceContext): Promise<AgentVoiceConnection>;
}>;
export type AgentHuddleOptions = {
  provider: AgentVoiceProvider;
  openAudio: OpenHuddleAudio;
  signal?: AbortSignal;
};
