export function isVoiceWebSocket(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return true;
  return url.protocol === "wss:" && globalThis.location?.protocol === "https:" && url.host === globalThis.location.host;
}
