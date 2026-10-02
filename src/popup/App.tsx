import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { MessagingClient } from "../messaging/client";
import type { EventEnvelope } from "../messaging/events";
import { MediaIngestClient } from "../media/media-ingest-client";
import type { MediaRecord } from "../media/media-types";
import type { CapCamState } from "../shared/types";
import { StatusRow } from "./components/StatusRow";

const client = new MessagingClient();
const ingestClient = new MediaIngestClient(client);

const MEDIA_STATUS_ORDER: Readonly<Record<MediaRecord["status"], number>> = {
  NEW: 0,
  VALIDATING: 1,
  LOADING: 2,
  READY: 3,
  IN_USE: 4,
  ERROR: 5,
  RELEASING: 6,
  RELEASED: 7,
};

function upsertMediaRecord(records: MediaRecord[], incoming: MediaRecord): MediaRecord[] {
  const current = records.find((record) => record.id === incoming.id);
  if (current !== undefined && MEDIA_STATUS_ORDER[current.status] > MEDIA_STATUS_ORDER[incoming.status]) return records;
  return [incoming, ...records.filter((record) => record.id !== incoming.id)];
}

function applyMediaEvent(records: MediaRecord[], event: EventEnvelope, removedIds: Set<string>): MediaRecord[] {
  switch (event.type) {
    case "media.registered":
    case "media.loading":
    case "media.ready":
    case "media.failed":
    case "media.released":
      if (removedIds.has(event.payload.mediaId)) return records;
      return upsertMediaRecord(records, event.payload.record);
    case "media.removed":
      removedIds.add(event.payload.mediaId);
      return records.filter((record) => record.id !== event.payload.mediaId);
    default:
      return records;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function App() {
  const [state, setState] = useState<CapCamState | null>(null);
  const [mediaRecords, setMediaRecords] = useState<MediaRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadCount, setUploadCount] = useState(0);
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const removedMediaIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await client.send("runtime.getStatus");
      setState(nextState);
      const nextMedia = await client.send("media.list");
      setMediaRecords(nextMedia);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CapCam runtime is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type.startsWith("media.")) {
        setMediaRecords((current) => applyMediaEvent(current, event, removedMediaIds.current));
      }
    });
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const onFilesSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    setMediaError(null);
    setUploadCount((count) => count + files.length);

    await Promise.all(files.map(async (file) => {
      try {
        const record = await ingestClient.ingest(file);
        if (!removedMediaIds.current.has(record.id)) {
          setMediaRecords((current) => upsertMediaRecord(current, record));
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "The selected file could not be loaded.";
        setMediaError((current) => current === null ? message : `${current}\n${message}`);
      } finally {
        setUploadCount((count) => Math.max(0, count - 1));
      }
    }));
  };

  const removeMedia = async (mediaId: string): Promise<void> => {
    setMediaError(null);
    setRemovingIds((current) => new Set(current).add(mediaId));
    try {
      await client.send("media.remove", { mediaId });
      removedMediaIds.current.add(mediaId);
      setMediaRecords((current) => current.filter((record) => record.id !== mediaId));
    } catch (caught) {
      setMediaError(caught instanceof Error ? caught.message : "Media could not be released.");
    } finally {
      setRemovingIds((current) => {
        const next = new Set(current);
        next.delete(mediaId);
        return next;
      });
    }
  };

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
        <button className="icon-button" type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh status">
          ↻
        </button>
      </header>

      <section className={`readiness-card ${ready ? "is-ready" : ""}`} aria-live="polite">
        <span className="readiness-dot" aria-hidden="true" />
        <div>
          <strong>{loading ? "Checking runtime" : ready ? "Extension Ready" : "Runtime Attention"}</strong>
          <p>{ready ? "Media stays on this device." : "Phase 02 · Local media engine"}</p>
        </div>
      </section>

      <section className="status-list" aria-label="Runtime status">
        <StatusRow label="Runtime" status={state?.runtime.status ?? "UNKNOWN"} />
        <StatusRow label="Offscreen" status={state?.offscreen.status ?? "UNKNOWN"} />
      </section>

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      <section className="media-section" aria-label="Local media">
        <div className="section-heading">
          <div>
            <h2>Local media</h2>
            <p>Images and video · 512 MiB safety limit</p>
          </div>
          <label className={`upload-button ${uploadCount > 0 ? "is-busy" : ""}`}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,video/mp4,video/webm,video/ogg"
              multiple
              onChange={(event) => void onFilesSelected(event)}
              aria-label="Upload image or video files"
            />
            {uploadCount > 0 ? `Loading ${uploadCount}…` : "Upload files"}
          </label>
        </div>

        {mediaError !== null && <p className="error-message media-error" role="alert">{mediaError}</p>}

        {mediaRecords.length === 0 ? (
          <div className="empty-media">No media loaded yet.</div>
        ) : (
          <ul className="media-list">
            {mediaRecords.map((record) => {
              const duration = formatDuration(record.duration);
              const dimensions = record.width !== null && record.height !== null
                ? `${record.width} × ${record.height}`
                : "Reading metadata…";
              return (
                <li className="media-card" key={record.id}>
                  <div className={`media-kind media-kind-${record.kind}`} aria-hidden="true">
                    {record.kind === "image" ? "IMG" : "VID"}
                  </div>
                  <div className="media-details">
                    <strong title={record.name}>{record.name}</strong>
                    <span>{dimensions}{duration === null ? "" : ` · ${duration}`}</span>
                    <span>{record.mimeType} · {formatBytes(record.size)}</span>
                    {record.error !== undefined && <span className="media-inline-error">{record.error.message}</span>}
                  </div>
                  <div className={`media-status media-status-${record.status.toLowerCase()}`}>
                    <span className="status-indicator" aria-hidden="true" />
                    {record.status}
                  </div>
                  <button
                    className="remove-button"
                    type="button"
                    onClick={() => void removeMedia(record.id)}
                    disabled={removingIds.has(record.id)}
                    aria-label={`Remove ${record.name}`}
                  >
                    {removingIds.has(record.id) ? "…" : "×"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer>Phase 02 · Media Engine · Local-only processing</footer>
    </main>
  );
}
