export type SiteMode = "unknown" | "supported" | "unsupported";

export interface SiteContext {
  hostname: string;
  supported: boolean;
  mode: SiteMode;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** Classifies hostnames only when a later phase supplies an explicit support list. */
export function createSiteContext(hostname: string, supportedHosts?: readonly string[]): SiteContext {
  const normalized = normalizeHostname(hostname);
  if (normalized.length === 0 || normalized.length > 253) {
    return { hostname: "", supported: false, mode: "unknown" };
  }
  if (supportedHosts === undefined) {
    return { hostname: normalized, supported: false, mode: "unknown" };
  }
  const isSupported = supportedHosts.some((host) => normalizeHostname(host) === normalized);
  return {
    hostname: normalized,
    supported: isSupported,
    mode: isSupported ? "supported" : "unsupported",
  };
}
