import { useCallback, useEffect, useState } from "react";
import { MessagingClient } from "../messaging/client";
import type { CapCamState } from "../shared/types";
import { StatusRow } from "./components/StatusRow";

const client = new MessagingClient();

export function App() {
  const [state, setState] = useState<CapCamState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await client.send("runtime.getStatus");
      setState(nextState);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CapCam runtime is unavailable.");
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = state?.runtime.status === "READY" && state.offscreen.status === "READY";

  return (
    <main className="popup-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <h1>CAPCAM</h1>
          <p className="tagline">Local media. Your browser.</p>
        </div>
      </header>

      <section className={`readiness-card ${ready ? "is-ready" : ""}`} aria-live="polite">
        <span className="readiness-dot" aria-hidden="true" />
        <div>
          <strong>{loading ? "Checking runtime" : ready ? "Extension Ready" : "Runtime Attention"}</strong>
          <p>{ready ? "Core services are responding." : "Phase 01 foundation status"}</p>
        </div>
      </section>

      <section className="status-list" aria-label="Runtime status">
        <StatusRow label="Runtime" status={state?.runtime.status ?? "UNKNOWN"} />
        <StatusRow label="Offscreen" status={state?.offscreen.status ?? "UNKNOWN"} />
      </section>

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={loading}>
        {loading ? "Connecting…" : "Refresh status"}
      </button>
      <footer>Phase 01 · Architecture &amp; Foundation</footer>
    </main>
  );
}
