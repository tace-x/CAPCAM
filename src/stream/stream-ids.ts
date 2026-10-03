let fallbackCounter = 0;

function randomToken(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID().replaceAll("-", "");
  if (typeof cryptoApi?.getRandomValues === "function") {
    return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}${fallbackCounter.toString(36)}`;
}

export function generateStreamId(): string {
  return `stream_${randomToken()}`;
}
