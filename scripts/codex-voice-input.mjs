const maxFieldBytes = 4096;
const truncated = "…";

// Match the app-server's RealtimeDelegation rendering to bind structured
// transcript entries to the native userMessage for the same backing turn.
function escapeField(text, keepEnd = false) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const bytes = Buffer.from(escaped);
  if (bytes.length <= maxFieldBytes) return escaped;

  const retained = maxFieldBytes - Buffer.byteLength(truncated);
  let boundary = keepEnd ? bytes.length - retained : retained;
  while ((bytes[boundary] & 0xc0) === 0x80) boundary += keepEnd ? 1 : -1;
  if (keepEnd) return truncated + bytes.subarray(boundary).toString();
  return bytes.subarray(0, boundary).toString() + truncated;
}

export function readRealtimeHandoff(item) {
  if (item?.type !== "handoff_request" || typeof item.input_transcript !== "string" ||
      !Array.isArray(item.active_transcript) ||
      !item.active_transcript.every(entry => typeof entry?.role === "string" && typeof entry.text === "string")) {
    return undefined;
  }
  const utterance = item.active_transcript.findLast(entry => entry.role === "user")?.text.trim();
  if (!utterance || utterance.length > 8000) return undefined;

  const transcript = item.active_transcript.map(entry => `${entry.role}: ${entry.text}`).join("\n");
  const input = escapeField(item.input_transcript || transcript);
  const message = [
    "<realtime_delegation>",
    `  <input>${input}</input>`,
    `  <transcript_delta>${escapeField(transcript, true)}</transcript_delta>`,
    "</realtime_delegation>",
  ].join("\n");
  return { message, utterance };
}
