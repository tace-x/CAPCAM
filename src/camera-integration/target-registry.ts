import { normalizeWebOrigin } from "./origin";
import type { TargetAdapter, TargetAdapterResolver } from "./types";

export interface TargetAdapterRegistration {
  /** Exact supported origin; wildcard hosts and path-based routing are rejected. */
  origin: string;
  adapter: TargetAdapter;
}

/**
 * Explicit allowlist resolver. An empty registry supports no page, and an unknown
 * origin never falls through to a generic/arbitrary-site adapter.
 */
export class ExactOriginTargetRegistry implements TargetAdapterResolver {
  private readonly adapters = new Map<string, TargetAdapter>();

  constructor(registrations: readonly TargetAdapterRegistration[] = []) {
    for (const registration of registrations) {
      const origin = normalizeWebOrigin(registration.origin);
      if (origin === null || origin !== registration.origin) {
        throw new Error("Target adapters must be registered against a normalized exact HTTP(S) origin.");
      }
      if (this.adapters.has(origin)) throw new Error(`A target adapter is already registered for ${origin}.`);
      this.adapters.set(origin, registration.adapter);
    }
  }

  resolve(origin: string): TargetAdapter | null {
    return this.adapters.get(origin) ?? null;
  }
}
