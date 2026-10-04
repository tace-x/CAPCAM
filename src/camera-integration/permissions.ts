import {
  exactHostPermissionPattern,
  normalizeWebOrigin,
  originFromExactHostPermissionPattern,
} from "./origin";
import type {
  OriginPermissionBroker,
  PermissionQueryResult,
  PermissionRequestResult,
  Unsubscribe,
} from "./types";

export interface ChromePermissionsPort {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
  onRemoved?: {
    addListener(listener: (permissions: { origins?: string[] }) => void): void;
    removeListener(listener: (permissions: { origins?: string[] }) => void): void;
  };
}

/**
 * Per-origin optional permissions adapter. It requests exactly one declared host
 * pattern derived from the selected origin; broad/wildcard declarations are not used.
 */
export class ChromeOptionalOriginPermissionBroker implements OriginPermissionBroker {
  constructor(
    private readonly permissions: ChromePermissionsPort | null,
    private readonly declaredOptionalHostPermissions: readonly string[],
  ) {}

  async contains(origin: string): Promise<PermissionQueryResult> {
    const pattern = this.declaredPattern(origin);
    if (pattern === null || this.permissions === null) return "unavailable";
    try {
      return await this.permissions.contains({ origins: [pattern] }) ? "granted" : "required";
    } catch {
      return "unavailable";
    }
  }

  /** Call only from a future explicit user activation handler. */
  async request(origin: string): Promise<PermissionRequestResult> {
    const pattern = this.declaredPattern(origin);
    if (pattern === null || this.permissions === null) return "unavailable";
    try {
      return await this.permissions.request({ origins: [pattern] }) ? "granted" : "denied";
    } catch {
      return "unavailable";
    }
  }

  subscribeRevoked(listener: (origin: string) => void): Unsubscribe {
    const event = this.permissions?.onRemoved;
    if (event === undefined) return () => undefined;

    const handler = (removed: { origins?: string[] }): void => {
      for (const pattern of removed.origins ?? []) {
        const origin = originFromExactHostPermissionPattern(pattern);
        if (origin !== null && this.declaredOptionalHostPermissions.includes(pattern)) listener(origin);
      }
    };
    event.addListener(handler);
    return () => event.removeListener(handler);
  }

  private declaredPattern(origin: string): string | null {
    const normalized = normalizeWebOrigin(origin);
    if (normalized === null) return null;
    const pattern = exactHostPermissionPattern(normalized);
    if (pattern === null || !this.declaredOptionalHostPermissions.includes(pattern)) return null;
    return pattern;
  }
}

/** Uses only Chrome's already-declared optional host patterns; it adds no permissions. */
export function createChromeOptionalOriginPermissionBroker(): OriginPermissionBroker {
  if (typeof chrome === "undefined" || chrome.runtime?.getManifest === undefined) {
    return new ChromeOptionalOriginPermissionBroker(null, []);
  }

  let declarations: string[] = [];
  try {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.ManifestV3 & {
      optional_host_permissions?: string[];
    };
    declarations = manifest.optional_host_permissions ?? [];
  } catch {
    declarations = [];
  }

  const permissions = typeof chrome.permissions === "undefined"
    ? null
    : chrome.permissions as unknown as ChromePermissionsPort;
  return new ChromeOptionalOriginPermissionBroker(permissions, declarations);
}
