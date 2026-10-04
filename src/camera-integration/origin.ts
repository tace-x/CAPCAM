const WEB_SCHEMES = new Set(["http:", "https:"]);

/** Returns an exact web origin and rejects extension, opaque, credentialed, or malformed URLs. */
export function normalizeWebOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (!WEB_SCHEMES.has(url.protocol) || url.username !== "" || url.password !== "" || url.hostname.includes("*")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Chrome host permission patterns are host-scoped (not port-scoped). This helper
 * deliberately produces a single scheme + exact hostname pattern, never a wildcard.
 */
export function exactHostPermissionPattern(origin: string): string | null {
  const normalized = normalizeWebOrigin(origin);
  if (normalized === null) return null;
  const url = new URL(normalized);
  // Chrome match patterns cannot limit a permission to a non-default TCP port.
  // Refuse such origins rather than expanding the user's selected scope.
  if (url.port !== "") return null;
  return `${url.protocol}//${url.hostname}/*`;
}

/** Accept only a concrete scheme/hostname pattern when processing onRemoved events. */
export function originFromExactHostPermissionPattern(pattern: string): string | null {
  const match = /^(https?):\/\/([^/*]+)\/\*$/.exec(pattern);
  if (match === null) return null;
  return normalizeWebOrigin(`${match[1]}://${match[2]}`);
}
