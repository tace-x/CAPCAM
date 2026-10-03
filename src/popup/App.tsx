import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { DEFAULT_RENDER_CONFIG, RENDER_PRESETS, type RenderFitMode } from "../canvas/render-types";
import { MessagingClient } from "../messaging/client";
import type { EventEnvelope } from "../messaging/events";
import { MediaIngestClient } from "../media/media-ingest-client";
import type { MediaRecord } from "../media/media-types";
import type { CapCamState } from "../shared/types";
import type { StreamInfo } from "../stream/stream-types";
import type { PlaybackRecord } from "../playback/playback-types";
import type { PlaybackEventEnvelope } from "../playback/playback-events";
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

function formatTrackSettings(stream: StreamInfo | null): string {
  const settings = stream?.track?.settings;
  if (settings === undefined) return "Track settings not available";
  const dimensions = settings.width !== null && settings.height !== null
    ? `${settings.width} × ${settings.height}`
    : "size pending";
  const fps = settings.frameRate === null ? "FPS pending" : `${settings.frameRate.toFixed(1)} FPS`;
  return `${dimensions} · ${fps}`;
}

function formatPlaybackTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const totalSeconds = Math.floor(Math.max(0, value));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function App() {
  const [state, setState] = useState<CapCamState | null>(null);
  const [mediaRecords, setMediaRecords] = useState<MediaRecord[]>([]);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackRecord | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackSeekDraft, setPlaybackSeekDraft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamLoading, setStreamLoading] = useState(false);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState(RENDER_PRESETS[0]?.id ?? "1280x720@30");
  const [fitMode, setFitMode] = useState<RenderFitMode>(DEFAULT_RENDER_CONFIG.fitMode);
  const [mirror, setMirror] = useState(DEFAULT_RENDER_CONFIG.mirror);
  const removedMediaIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await client.send("runtime.getStatus");
      setState(nextState);
      const nextMedia = await client.send("media.list");
      setMediaRecords(nextMedia);
      try {
        setStreamInfo(await client.send("stream.getState"));
      } catch (caught) {
        setStreamError(caught instanceof Error ? caught.message : "Stream status is unavailable.");
      }
      try {
        setPlaybackInfo(await client.send("playback.getState"));
      } catch (caught) {
        setPlaybackError(caught instanceof Error ? caught.message : "Playback status is unavailable.");
      }
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
      if (event.type === "stream.stateChanged") {
        setStreamInfo(event.payload);
        setState((current) => current === null
          ? current
          : { ...current, stream: { status: event.payload.state } });
      }
      if (event.type.startsWith("playback.")) {
        const playbackEvent = event as PlaybackEventEnvelope;
        if (playbackEvent.type !== "playback.timeupdate") setPlaybackSeekDraft(null);
        setPlaybackInfo(playbackEvent.type === "playback.disposed" ? null : playbackEvent.payload.record);
        if (playbackEvent.type === "playback.error") setPlaybackError(playbackEvent.payload.record.error?.message ?? "Playback failed.");
        else setPlaybackError(null);
      }
    });
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const readyMedia = mediaRecords.filter((record) => record.status === "READY" || record.status === "IN_USE");
  useEffect(() => {
    if (readyMedia.some((record) => record.id === selectedMediaId)) return;
    setSelectedMediaId(readyMedia[0]?.id ?? "");
  }, [readyMedia, selectedMediaId]);

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
          setSelectedMediaId((current) => current || record.id);
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

  const runStreamCommand = async (operation: () => Promise<StreamInfo>): Promise<void> => {
    setStreamLoading(true);
    setStreamError(null);
    try {
      const next = await operation();
      setStreamInfo(next);
      setState((current) => current === null ? current : { ...current, stream: { status: next.state } });
      try {
        setPlaybackInfo(await client.send("playback.getState"));
      } catch {
        // Keep the last playback snapshot if the stream command succeeded but state refresh did not.
      }
    } catch (caught) {
      setStreamError(caught instanceof Error ? caught.message : "The stream command failed.");
      try {
        setStreamInfo(await client.send("stream.getState"));
      } catch {
        // Keep the last serializable stream snapshot visible if status lookup also fails.
      }
    } finally {
      setStreamLoading(false);
    }
  };

  const runPlaybackCommand = async (operation: () => Promise<PlaybackRecord | null>): Promise<void> => {
    setPlaybackLoading(true);
    setPlaybackError(null);
    try {
      setPlaybackInfo(await operation());
      setPlaybackSeekDraft(null);
    } catch (caught) {
      setPlaybackError(caught instanceof Error ? caught.message : "The playback command failed.");
      try {
        setPlaybackInfo(await client.send("playback.getState"));
      } catch {
        // Keep the last safe playback snapshot visible.
      }
    } finally {
      setPlaybackLoading(false);
    }
  };

  const loadPlayback = (): Promise<void> => {
    if (selectedMediaId === "") return Promise.resolve();
    setPlaybackLoading(true);
    setPlaybackError(null);
    return client.send("playback.load", { mediaId: selectedMediaId }).then((record) => {
      setPlaybackInfo(record);
      setPlaybackSeekDraft(null);
    }).catch((caught: unknown) => {
      setPlaybackError(caught instanceof Error ? caught.message : "The selected media could not be loaded for playback.");
    }).finally(() => setPlaybackLoading(false));
  };

  const playbackCommand = (command: "playback.play" | "playback.pause" | "playback.stop" | "playback.restart") => (): Promise<void> => {
    const playbackId = playbackInfo?.playbackId;
    if (playbackId === undefined) return Promise.resolve();
    return runPlaybackCommand(() => client.send(command, { playbackId }));
  };

  const seekPlayback = (): Promise<void> => {
    const playbackId = playbackInfo?.playbackId;
    if (playbackId === undefined || playbackSeekDraft === null) return Promise.resolve();
    const time = playbackSeekDraft;
    return runPlaybackCommand(() => client.send("playback.seek", { playbackId, time }));
  };

  const setPlaybackLoop = (enabled: boolean): Promise<void> => {
    const playbackId = playbackInfo?.playbackId;
    if (playbackId === undefined) return Promise.resolve();
    return runPlaybackCommand(() => client.send("playback.setLoop", { playbackId, enabled }));
  };

  const setPlaybackRate = (rate: number): Promise<void> => {
    const playbackId = playbackInfo?.playbackId;
    if (playbackId === undefined) return Promise.resolve();
    return runPlaybackCommand(() => client.send("playback.setRate", { playbackId, rate }));
  };

  const disposePlayback = (): Promise<void> => {
    const playbackId = playbackInfo?.playbackId;
    if (playbackId === undefined) return Promise.resolve();
    return runPlaybackCommand(() => client.send("playback.dispose", { playbackId }));
  };

  const createStream = (): Promise<void> => {
    const preset = RENDER_PRESETS.find((candidate) => candidate.id === selectedPresetId) ?? RENDER_PRESETS[0];
    if (selectedMediaId === "" || preset === undefined) return Promise.resolve();
    return runStreamCommand(() => client.send("stream.create", {
      mediaId: selectedMediaId,
      config: {
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        fitMode,
        mirror,
      },
    }));
  };

  const streamId = streamInfo?.streamId ?? null;
  const canControlStream = streamId !== null && streamInfo !== null && !streamInfo.disposed;
  const hasUndisposedStream = streamInfo !== null && streamInfo.streamId !== null && !streamInfo.disposed;
  const startable = streamInfo !== null && ["READY", "STOPPED", "ERROR"].includes(streamInfo.state);
  const stoppable = streamInfo !== null && ["READY", "ACTIVE", "ERROR"].includes(streamInfo.state);
  const restartable = streamInfo !== null && ["READY", "ACTIVE", "STOPPED", "ERROR"].includes(streamInfo.state);
  const switchable = streamInfo !== null && ["READY", "ACTIVE", "STOPPED"].includes(streamInfo.state);
  const ready = state?.runtime.status === "READY" && state.offscreen.status === "READY";

  return (
    <main className="popup-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <div>
          <h1>CAPCAM</h1>
          <p className="tagline">Local media. Your browser.</p>
        </div>
        <button className="icon-button" type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh status">↻</button>
      </header>

      <section className={`readiness-card ${ready ? "is-ready" : ""}`} aria-live="polite">
        <span className="readiness-dot" aria-hidden="true" />
        <div>
          <strong>{loading ? "Checking runtime" : ready ? "Extension Ready" : "Runtime Attention"}</strong>
          <p>{ready ? "Media stays on this device." : "Phase 05 · Offscreen runtime coordination"}</p>
        </div>
      </section>

      <section className="status-list" aria-label="Runtime status">
        <StatusRow label="Runtime" status={state?.runtime.status ?? "UNKNOWN"} />
        <StatusRow label="Offscreen" status={state?.offscreen.status ?? "UNKNOWN"} />
        <StatusRow label="Stream" status={streamInfo?.state ?? state?.stream.status ?? "IDLE"} />
      </section>

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      <section className="stream-section" aria-label="Canvas stream controls">
        <div className="section-heading">
          <div>
            <h2>Canvas stream</h2>
            <p>Render local media to an offscreen canvas track</p>
          </div>
        </div>
        <label className="field-label" htmlFor="stream-source">Source</label>
        <select id="stream-source" className="control-select" value={selectedMediaId} onChange={(event) => setSelectedMediaId(event.currentTarget.value)} disabled={readyMedia.length === 0 || streamLoading}>
          {readyMedia.length === 0 ? <option value="">Upload media first</option> : readyMedia.map((record) => <option key={record.id} value={record.id}>{record.name} · {record.kind}</option>)}
        </select>
        <div className="render-controls">
          <label className="control-group">
            <span>Output preset</span>
            <select className="control-select" value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.currentTarget.value)} disabled={streamLoading}>
              {RENDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
          <label className="control-group">
            <span>Fit</span>
            <select className="control-select" value={fitMode} onChange={(event) => setFitMode(event.currentTarget.value as RenderFitMode)} disabled={streamLoading}>
              <option value="cover">Cover · crop</option>
              <option value="contain">Contain · letterbox</option>
            </select>
          </label>
        </div>
        <label className="check-control">
          <input type="checkbox" checked={mirror} onChange={(event) => setMirror(event.currentTarget.checked)} disabled={streamLoading} />
          <span>Mirror horizontally</span>
        </label>
        <div className="stream-actions">
          <button type="button" className="primary-button" onClick={() => void createStream()} disabled={selectedMediaId === "" || streamLoading || !ready || hasUndisposedStream}>
            {hasUndisposedStream ? "Stream created" : "Create stream"}
          </button>
          <button type="button" className="secondary-button" onClick={() => void runStreamCommand(() => client.send("stream.start", { streamId: streamId ?? "" }))} disabled={!canControlStream || !startable || streamLoading}>Start</button>
          <button type="button" className="secondary-button" onClick={() => void runStreamCommand(() => client.send("stream.stop", { streamId: streamId ?? "" }))} disabled={!canControlStream || !stoppable || streamLoading}>Stop</button>
        </div>
        <div className="stream-actions stream-actions-secondary">
          <button type="button" className="secondary-button" onClick={() => void runStreamCommand(() => client.send("stream.restart", { streamId: streamId ?? "" }))} disabled={!canControlStream || !restartable || streamLoading}>Restart</button>
          <button type="button" className="secondary-button" onClick={() => void runStreamCommand(() => client.send("stream.switchSource", { streamId: streamId ?? "", mediaId: selectedMediaId }))} disabled={!canControlStream || !switchable || streamInfo?.sourceMediaId === selectedMediaId || selectedMediaId === "" || streamLoading}>Switch source</button>
          <button type="button" className="danger-button" onClick={() => void runStreamCommand(() => client.send("stream.dispose", { streamId: streamId ?? "" }))} disabled={!canControlStream || streamLoading}>Dispose</button>
        </div>
        {streamInfo !== null && <div className="track-inspection" aria-live="polite">
          <div><span>Stream ID</span><code>{streamInfo.streamId ?? "Not created"}</code></div>
          <div><span>Track</span><strong>{streamInfo.track?.readyState ?? "—"}</strong></div>
          <div><span>Actual settings</span><strong>{formatTrackSettings(streamInfo)}</strong></div>
          {streamInfo.error !== null && <p className="error-message" role="alert">{streamInfo.error.code}: {streamInfo.error.message}</p>}
        </div>}
        {streamError !== null && <p className="error-message" role="alert">{streamError}</p>}
        <p className="stream-note">Production streams remain in the offscreen runtime; the popup receives only typed commands and serializable track details.</p>
        <a className="developer-link" href="./developer-test.html" target="_blank" rel="noreferrer">Open local developer preview harness ↗</a>
      </section>

      <section className="playback-section" aria-label="Playback controls">
        <div className="section-heading">
          <div><h2>Playback</h2><p>Controls source timing independently from the stream.</p></div>
          <StatusRow label="Playback" status={playbackInfo?.state ?? "IDLE"} />
        </div>
        <div className="playback-actions">
          <button type="button" className="secondary-button" onClick={() => void loadPlayback()} disabled={selectedMediaId === "" || playbackLoading || !ready}>Load source</button>
          <button type="button" className="primary-button" onClick={playbackCommand("playback.play")} disabled={playbackInfo === null || playbackLoading || playbackInfo.state === "PLAYING" || playbackInfo.state === "LOADING" || playbackInfo.state === "ERROR"}>Play</button>
          <button type="button" className="secondary-button" onClick={playbackCommand("playback.pause")} disabled={playbackInfo?.state !== "PLAYING" || playbackLoading}>Pause</button>
          <button type="button" className="secondary-button" onClick={playbackCommand("playback.stop")} disabled={playbackInfo === null || playbackLoading || ["STOPPED", "LOADING"].includes(playbackInfo.state)}>Stop</button>
          <button type="button" className="secondary-button" onClick={playbackCommand("playback.restart")} disabled={playbackInfo === null || playbackLoading || ["LOADING", "ERROR"].includes(playbackInfo.state)}>Restart</button>
          <button type="button" className="danger-button" onClick={() => void disposePlayback()} disabled={playbackInfo === null || playbackLoading}>Unload</button>
        </div>
        <div className="playback-options">
          <label className="check-control">
            <input type="checkbox" checked={playbackInfo?.loop ?? false} onChange={(event) => void setPlaybackLoop(event.currentTarget.checked)} disabled={playbackInfo === null || playbackLoading} />
            <span>Loop</span>
          </label>
          <label className="playback-rate-control">
            <span>Speed</span>
            <select className="control-select" value={playbackInfo?.playbackRate ?? 1} onChange={(event) => void setPlaybackRate(Number(event.currentTarget.value))} disabled={playbackInfo === null || playbackLoading}>
              <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option>
              <option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option>
            </select>
          </label>
        </div>
        <div className="playback-seek-row">
          <label htmlFor="playback-seek">Seek</label>
          <input id="playback-seek" type="range" min="0" max={playbackInfo?.duration ?? 0} step="0.1" value={Math.min(playbackSeekDraft ?? playbackInfo?.currentTime ?? 0, playbackInfo?.duration ?? 0)} onChange={(event) => setPlaybackSeekDraft(Number(event.currentTarget.value))} disabled={playbackInfo?.kind !== "video" || playbackInfo.duration === null || playbackLoading} />
          <output>{formatPlaybackTime(playbackSeekDraft ?? playbackInfo?.currentTime ?? 0)} / {formatPlaybackTime(playbackInfo?.duration ?? null)}</output>
          <button type="button" className="secondary-button" onClick={() => void seekPlayback()} disabled={playbackInfo?.kind !== "video" || playbackInfo.duration === null || playbackSeekDraft === null || playbackLoading}>Seek</button>
        </div>
        {playbackInfo?.kind === "image" && <p className="playback-note">Images are held at currentTime 0. Set an optional duration through the local developer harness; without one, presentation continues until stopped.</p>}
        {playbackError !== null && <p className="error-message" role="alert">{playbackError}</p>}
        {playbackInfo?.error !== null && playbackInfo?.error !== undefined && <p className="error-message" role="alert">{playbackInfo.error.code}: {playbackInfo.error.message}</p>}
      </section>

      <section className="media-section" aria-label="Local media">
        <div className="section-heading">
          <div>
            <h2>Local media</h2>
            <p>Images and video · 512 MiB safety limit</p>
          </div>
          <label className={`upload-button ${uploadCount > 0 ? "is-busy" : ""}`}>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,video/mp4,video/webm,video/ogg" multiple onChange={(event) => void onFilesSelected(event)} aria-label="Upload image or video files" />
            {uploadCount > 0 ? `Loading ${uploadCount}…` : "Upload files"}
          </label>
        </div>
        {mediaError !== null && <p className="error-message media-error" role="alert">{mediaError}</p>}
        {mediaRecords.length === 0 ? <div className="empty-media">No media loaded yet.</div> : (
          <ul className="media-list">
            {mediaRecords.map((record) => {
              const duration = formatDuration(record.duration);
              const dimensions = record.width !== null && record.height !== null ? `${record.width} × ${record.height}` : "Reading metadata…";
              return (
                <li className="media-card" key={record.id}>
                  <div className={`media-kind media-kind-${record.kind}`} aria-hidden="true">{record.kind === "image" ? "IMG" : "VID"}</div>
                  <div className="media-details">
                    <strong title={record.name}>{record.name}</strong>
                    <span>{dimensions}{duration === null ? "" : ` · ${duration}`}</span>
                    <span>{record.mimeType} · {formatBytes(record.size)}</span>
                    {record.error !== undefined && <span className="media-inline-error">{record.error.message}</span>}
                  </div>
                  <div className={`media-status media-status-${record.status.toLowerCase()}`}><span className="status-indicator" aria-hidden="true" />{record.status}</div>
                  <button className="remove-button" type="button" onClick={() => void removeMedia(record.id)} disabled={removingIds.has(record.id)} aria-label={`Remove ${record.name}`}>
                    {removingIds.has(record.id) ? "…" : "×"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer>Phase 05 · Offscreen runtime · Local-only</footer>
    </main>
  );
}
