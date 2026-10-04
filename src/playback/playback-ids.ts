let fallbackCounter = 0;

export function generatePlaybackId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `playback_${cryptoApi.randomUUID().replaceAll("-", "")}`;
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `playback_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  fallbackCounter += 1;
  return `playback_${Date.now().toString(36)}-${fallbackCounter.toString(36).padStart(8, "0")}`;
}
