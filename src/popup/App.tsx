import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { DEFAULT_RENDER_CONFIG, RENDER_PRESETS, type RenderFitMode, type RenderPreset } from "../canvas/render-types";
import { MessagingClient } from "../messaging/client";
import type { EventEnvelope } from "../messaging/events";
import { MediaIngestClient } from "../media/media-ingest-client";
import type { MediaRecord } from "../media/media-types";
import type { CapCamState } from "../shared/types";
import type { StreamInfo } from "../stream/stream-types";
import type { PlaybackRecord } from "../playback/playback-types";
import type { PlaybackEventEnvelope } from "../playback/playback-events";
import type { CameraIntegrationStatusUpdate } from "../camera-integration/handoff";
import { StatusRow } from "./components/StatusRow";
import { ErrorSurface } from "./components/ErrorSurface";
import { KeyboardHelpModal } from "./components/KeyboardHelpModal";

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

function humanReadableReason(reason: string | null): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "PERMISSION_REQUIRED": return "Origin permission required. Click 'Camera ON' to grant access.";
    case "PERMISSION_DENIED": return "Origin permission was denied in Chrome.";
    case "PERMISSION_REVOKED": return "Origin permission was revoked in Chrome.";
    case "PERMISSION_UNAVAILABLE": return "Chrome permissions API is unavailable.";
    case "NO_WEBRTC_CONNECTION": return "No controlled WebRTC peer connection detected.";
    case "NO_VIDEO_SENDER": return "No active video sender found in the target connection.";
    case "AMBIGUOUS_VIDEO_SENDERS": return "Multiple video senders detected. Only a single controlled sender is supported.";
    case "UNSUPPORTED_ORIGIN": return "Target origin is not supported or not normalized.";
    case "NO_SUPPORTED_TARGET_ADAPTER": return "No target adapter registered for this origin.";
    case "TARGET_DISCONNECTED": return "WebRTC target connection disconnected.";
    case "SENDER_DISAPPEARED": return "WebRTC video sender disappeared.";
    case "PAGE_NAVIGATED": return "Target page navigated away.";
    case "PAGE_HIDDEN": return "Target page was hidden.";
    case "BLOCKED_PHASE_06_VERIFICATION": return "Blocked until Phase 06 receives real Chrome verification.";
    case "CAPCAM_STREAM_UNAVAILABLE": return "CapCam canvas stream is not yet created or active.";
    case "CAPCAM_TRACK_UNAVAILABLE": return "No live video track available in the CapCam stream.";
    case "CAPCAM_SOURCE_UNAVAILABLE": return "Selected media source is not available.";
    case "CAPCAM_SOURCE_SELECTION_FAILED": return "Failed to load selected media source.";
    case "TRACK_REPLACEMENT_FAILED": return "Sender track replacement failed (rolled back).";
    case "RESTORE_FAILED_DETACHED": return "Original track restoration failed; sender detached safely.";
    case "RESTORE_AND_DETACH_FAILED": return "Critical: unable to restore or detach video sender.";
    case "STREAM_ENDED": return "CapCam source stream ended.";
    default: return reason;
  }
}

export function App() {
  const [state, setState] = useState<CapCamState | null>(null);
  const [mediaRecords, setMediaRecords] = useState<MediaRecord[]>([]);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackRecord | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackSeekDraft, setPlaybackSeekDraft] = useState<number | null>(null);
  const [cameraUpdate, setCameraUpdate] = useState<CameraIntegrationStatusUpdate | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<Map<string, File>>(() => new Map());
  const [previewResource, setPreviewResource] = useState<{ file: File; url: string } | null>(null);
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
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const removedMediaIds = useRef<Set<string>>(new Set());

  const forgetPreview = useCallback((mediaId: string): void => {
    setPreviewFiles((current) => {
      if (!current.has(mediaId)) return current;
      const next = new Map(current);
      next.delete(mediaId);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await client.send("runtime.getStatus");
      setState(nextState);

      // Restore persisted settings into UI state
      try {
        const settings = await client.send("settings.get");
        setFitMode(settings.fitMode);
        setMirror(settings.mirror);
        const matchingPreset = RENDER_PRESETS.find(
          (p) => p.width === settings.width && p.height === settings.height && p.fps === settings.fps,
        ) ?? RENDER_PRESETS[0];
        if (matchingPreset !== undefined) {
          setSelectedPresetId(matchingPreset.id);
        }
      } catch {
        // Retain default render config if settings retrieval fails
      }

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

      try {
        const cameraSnapshot = await client.send("camera.getStatus");
        setCameraUpdate((current) => current !== null && current.revision > cameraSnapshot.revision ? current : cameraSnapshot);
        setCameraError(null);
      } catch (caught) {
        setCameraError(caught instanceof Error ? caught.message : "Camera integration status is unavailable.");
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
      if (event.type === "camera.statusChanged") {
        setCameraUpdate((current) => current !== null && current.revision > event.payload.revision ? current : event.payload);
        setCameraError(null);
      }
      if (event.type === "media.removed") forgetPreview(event.payload.mediaId);
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
  }, [refresh, forgetPreview]);

  const readyMedia = mediaRecords.filter((record) => record.status === "READY" || record.status === "IN_USE");
  const selectedMedia = mediaRecords.find((record) => record.id === selectedMediaId) ?? null;
  const selectedPreviewFile = previewFiles.get(selectedMediaId);
  const selectedPreviewUrl = previewResource !== null && previewResource.file === selectedPreviewFile ? previewResource.url : null;

  useEffect(() => {
    if (selectedPreviewFile === undefined || typeof URL.createObjectURL !== "function") {
      setPreviewResource(null);
      return;
    }
    const url = URL.createObjectURL(selectedPreviewFile);
    setPreviewResource({ file: selectedPreviewFile, url });
    return () => URL.revokeObjectURL(url);
  }, [selectedPreviewFile]);

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
          setPreviewFiles((current) => new Map(current).set(record.id, file));
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
      forgetPreview(mediaId);
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

  const handlePresetChange = (presetId: string): void => {
    setSelectedPresetId(presetId);
    const preset = RENDER_PRESETS.find((candidate) => candidate.id === presetId);
    if (preset !== undefined) {
      void client.send("settings.update", {
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
      }).catch(() => undefined);
    }
  };

  const handleFitModeChange = (mode: RenderFitMode): void => {
    setFitMode(mode);
    void client.send("settings.update", { fitMode: mode }).catch(() => undefined);
  };

  const handleMirrorChange = (isMirrored: boolean): void => {
    setMirror(isMirrored);
    void client.send("settings.update", { mirror: isMirrored }).catch(() => undefined);
  };

  const runCameraCommand = async (operation: () => Promise<CameraIntegrationStatusUpdate>): Promise<void> => {
    setCameraBusy(true);
    setCameraError(null);
    try {
      const update = await operation();
      setCameraUpdate((current) => current !== null && current.revision > update.revision ? current : update);
    } catch (caught) {
      setCameraError(caught instanceof Error ? caught.message : "The camera integration command failed.");
      try {
        const snapshot = await client.send("camera.getStatus");
        setCameraUpdate((current) => current !== null && current.revision > snapshot.revision ? current : snapshot);
      } catch {
        // Retain the last confirmed camera state if status reconciliation also fails.
      }
    } finally {
      setCameraBusy(false);
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
    if (playbackId !== undefined) {
      void runPlaybackCommand(() => client.send("playback.setLoop", { playbackId, enabled }));
    }
    void client.send("settings.update", { loop: enabled }).catch(() => undefined);
    return Promise.resolve();
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
    const preset = RENDER_PRESETS.find((candidate) => candidate.id === selectedPresetId) ?? RENDER_PRESETS[0] as RenderPreset;
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

  // Keyboard navigation and shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === "input" || activeTag === "select" || activeTag === "textarea") {
        if (e.key === "Escape") {
          (document.activeElement as HTMLElement)?.blur?.();
        }
        return;
      }

      if (e.key === "Escape") {
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
          e.preventDefault();
        } else if (error !== null || mediaError !== null || streamError !== null || cameraError !== null || playbackError !== null) {
          setError(null);
          setMediaError(null);
          setStreamError(null);
          setCameraError(null);
          setPlaybackError(null);
          e.preventDefault();
        }
        return;
      }

      if (e.key === "?") {
        setShowKeyboardHelp((current) => !current);
        e.preventDefault();
        return;
      }

      if (e.code === "Space") {
        if (playbackInfo?.state === "PLAYING") {
          void playbackCommand("playback.pause")();
          e.preventDefault();
        } else if (playbackInfo?.state === "PAUSED" || playbackInfo?.state === "STOPPED" || playbackInfo?.state === "ENDED") {
          void playbackCommand("playback.play")();
          e.preventDefault();
        }
        return;
      }

      if (e.key === "r" || e.key === "R") {
        if (playbackInfo !== null && !playbackLoading) {
          void playbackCommand("playback.restart")();
          e.preventDefault();
        }
        return;
      }

      if (e.key === "m" || e.key === "M") {
        handleMirrorChange(!mirror);
        e.preventDefault();
        return;
      }

      if (e.key === "c" || e.key === "C") {
        const cameraStatus = cameraUpdate?.status;
        const gateBlocked = cameraStatus?.state === "BLOCKED_PHASE_06_VERIFICATION";
        if (cameraStatus?.capcamActive === true) {
          void runCameraCommand(() => client.send("camera.disable"));
          e.preventDefault();
        } else if (cameraStatus?.supported === true && !gateBlocked) {
          void runCameraCommand(() => client.send("camera.enable"));
          e.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showKeyboardHelp, error, mediaError, streamError, cameraError, playbackError, playbackInfo, playbackLoading, mirror, cameraUpdate]);

  const streamId = streamInfo?.streamId ?? null;
  const canControlStream = streamId !== null && streamInfo !== null && !streamInfo.disposed;
  const hasUndisposedStream = streamInfo !== null && streamInfo.streamId !== null && !streamInfo.disposed;
  const startable = streamInfo !== null && ["READY", "STOPPED", "ERROR"].includes(streamInfo.state);
  const stoppable = streamInfo !== null && ["READY", "ACTIVE", "ERROR"].includes(streamInfo.state);
  const restartable = streamInfo !== null && ["READY", "ACTIVE", "STOPPED", "ERROR"].includes(streamInfo.state);
  const switchable = streamInfo !== null && ["READY", "ACTIVE", "STOPPED"].includes(streamInfo.state);
  const ready = state?.runtime.status === "READY" && state.offscreen.status === "READY";
  const cameraStatus = cameraUpdate?.status ?? null;
  const cameraGateBlocked = cameraStatus?.state === "BLOCKED_PHASE_06_VERIFICATION";
  const cameraCanEnable = cameraStatus?.supported === true && ["READY", "TARGET_REGISTERED", "SOURCE_READY", "BLOCKED"].includes(cameraStatus.state) &&
    cameraStatus.permission !== "unavailable" && !cameraGateBlocked;
  const cameraCanDisable = cameraStatus?.capcamActive === true;
  const cameraConnectionStatus = cameraStatus === null ? "UNKNOWN"
    : cameraGateBlocked ? "BLOCKED"
      : cameraStatus.state === "ERROR" ? "ERROR"
        : cameraStatus.supported && ["READY", "TARGET_REGISTERED", "SOURCE_READY", "ACTIVE"].includes(cameraStatus.state) ? "AVAILABLE"
          : cameraStatus.state === "BLOCKED" && cameraStatus.reason?.startsWith("PERMISSION_") ? "AVAILABLE"
            : cameraStatus.state === "BLOCKED" ? "DISCONNECTED" : "UNAVAILABLE";

  const derivedMediaStatus = mediaRecords.length === 0 ? "NONE"
    : mediaRecords.some((r) => r.status === "LOADING" || r.status === "VALIDATING") || uploadCount > 0 ? "LOADING"
      : mediaRecords.some((r) => r.status === "ERROR") || mediaError !== null ? "ERROR"
        : "READY";

  const derivedPlaybackStatus = playbackInfo?.state ?? "STOPPED";

  return (
    <main className="popup-shell">
      {/* 1. Header */}
      <header className="brand-row">
        <div className="brand-identity">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div className="brand-title-group">
            <h1>CAPCAM <span className="version-badge">v0.1.0</span></h1>
            <p className="tagline">Local-first media · In-browser</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => setShowKeyboardHelp(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ⌨
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh popup state"
            title="Refresh runtime status"
          >
            ↻
          </button>
        </div>
      </header>

      {/* 2. Runtime Health & Unified Status Strip */}
      <section className={`readiness-card ${ready ? "is-ready" : ""}`} aria-live="polite">
        <div className="readiness-info">
          <span className="readiness-dot" aria-hidden="true" />
          <div>
            <strong>{loading ? "Checking runtime…" : ready ? "Local Runtime Ready" : "Runtime Attention"}</strong>
            <p>{ready ? "Media stream processing stays in your local browser." : "Check runtime subsystems below."}</p>
          </div>
        </div>
        <span className="local-badge">Offline Local</span>
      </section>

      <section className="status-list" aria-label="Runtime status" aria-live="polite">
        <StatusRow label="Runtime" status={state?.runtime.status ?? "OFF"} />
        <StatusRow label="Media" status={derivedMediaStatus} />
        <StatusRow label="Stream" status={streamInfo?.state ?? state?.stream.status ?? "IDLE"} />
      </section>

      {/* Error Surface */}
      {error !== null && (
        <ErrorSurface
          title="Runtime Unavailable"
          message={error}
          actionLabel="Retry"
          onAction={() => void refresh()}
          onDismiss={() => setError(null)}
        />
      )}

      {/* 3. Local Media Source & Files */}
      <section className="section-container media-section" aria-label="Local media">
        <div className="section-heading">
          <div>
            <h2>Local media</h2>
            <p>512 MiB local safety bound</p>
          </div>
          <label className={`upload-button ${uploadCount > 0 ? "is-busy" : ""}`} htmlFor="media-upload-input">
            <input
              id="media-upload-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,video/mp4,video/webm,video/ogg"
              multiple
              onChange={(event) => void onFilesSelected(event)}
              aria-label="Upload image or video files"
            />
            {uploadCount > 0 ? `Loading (${uploadCount})…` : "Upload media"}
          </label>
        </div>

        {mediaError !== null && (
          <ErrorSurface
            title="Media Load Error"
            message={mediaError}
            actionLabel="Dismiss"
            onAction={() => setMediaError(null)}
            onDismiss={() => setMediaError(null)}
          />
        )}

        <div className="media-preview" aria-label="Selected media preview">
          <div className="preview-caption">
            <strong>{selectedMedia?.name ?? "No media selected"}</strong>
            <span>
              {selectedMedia?.kind === "video" ? "Video preview" : selectedMedia?.kind === "image" ? "Image preview" : "Upload local files to begin"}
            </span>
          </div>
          {selectedMedia === null ? (
            <div className="preview-placeholder">Upload an image or video above to inspect and route.</div>
          ) : selectedPreviewUrl === null ? (
            <div className="preview-placeholder">Session preview available for files uploaded in this window.</div>
          ) : selectedMedia.kind === "video" ? (
            <video
              className="media-preview-content"
              src={selectedPreviewUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={`Preview of ${selectedMedia.name}`}
            />
          ) : (
            <img
              className="media-preview-content"
              src={selectedPreviewUrl}
              alt={`Preview of ${selectedMedia.name}`}
            />
          )}
        </div>

        {mediaRecords.length === 0 ? (
          <div className="empty-media">No media loaded yet. Select local files to begin.</div>
        ) : (
          <ul className="media-list" aria-label="Loaded media files list">
            {mediaRecords.map((record) => {
              const duration = formatDuration(record.duration);
              const dimensions = record.width !== null && record.height !== null
                ? `${record.width} × ${record.height}`
                : "Dimensions pending…";
              return (
                <li className="media-card" key={record.id}>
                  <div className={`media-kind ${record.kind === "video" ? "media-kind-video" : ""}`} aria-hidden="true">
                    {record.kind === "image" ? "IMG" : "VID"}
                  </div>
                  <div className="media-details">
                    <strong title={record.name}>{record.name}</strong>
                    <span>{dimensions}{duration === null ? "" : ` · ${duration}`}</span>
                    <span>{record.mimeType} · {formatBytes(record.size)}</span>
                    {record.error !== undefined && (
                      <span className="media-inline-error">{record.error.message}</span>
                    )}
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
                    title="Remove media item"
                  >
                    {removingIds.has(record.id) ? "…" : "×"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 4. Canvas Stream Controls */}
      <section className="section-container stream-section" aria-label="Canvas stream controls">
        <div className="section-heading">
          <div>
            <h2>Canvas stream</h2>
            <p>Offscreen render pipeline to video track</p>
          </div>
          <StatusRow label="State" status={streamInfo?.state ?? "IDLE"} />
        </div>

        <label className="field-label" htmlFor="stream-source">Stream source</label>
        <select
          id="stream-source"
          className="control-select"
          value={selectedMediaId}
          onChange={(event) => {
            const nextMediaId = event.currentTarget.value;
            setSelectedMediaId(nextMediaId);
            if (canControlStream && switchable && streamId !== null && nextMediaId !== "") {
              void runStreamCommand(() => client.send("stream.switchSource", { streamId, mediaId: nextMediaId }));
            }
            if (cameraStatus?.capcamActive === true && nextMediaId !== "") {
              void runCameraCommand(() => client.send("camera.switchSource", { mediaId: nextMediaId }));
            }
          }}
          disabled={readyMedia.length === 0 || streamLoading}
          aria-label="Select source media for canvas stream"
        >
          {readyMedia.length === 0 ? (
            <option value="">Upload media first</option>
          ) : (
            readyMedia.map((record) => (
              <option key={record.id} value={record.id}>
                {record.name} · {record.kind.toUpperCase()}
              </option>
            ))
          )}
        </select>

        <div className="render-controls">
          <label className="control-group" htmlFor="output-preset">
            <span>Output preset</span>
            <select
              id="output-preset"
              className="control-select"
              value={selectedPresetId}
              onChange={(event) => handlePresetChange(event.currentTarget.value)}
              disabled={streamLoading}
              aria-label="Select canvas output resolution and frame rate preset"
            >
              {RENDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label className="control-group" htmlFor="fit-mode">
            <span>Fit mode</span>
            <select
              id="fit-mode"
              className="control-select"
              value={fitMode}
              onChange={(event) => handleFitModeChange(event.currentTarget.value as RenderFitMode)}
              disabled={streamLoading}
              aria-label="Select render fit mode"
            >
              <option value="contain">Contain · letterbox</option>
              <option value="cover">Cover · crop</option>
            </select>
          </label>
        </div>

        <label className="check-control" htmlFor="mirror-checkbox">
          <input
            id="mirror-checkbox"
            type="checkbox"
            checked={mirror}
            onChange={(event) => handleMirrorChange(event.currentTarget.checked)}
            disabled={streamLoading}
            aria-label="Mirror video stream horizontally"
          >
          </input>
          <span>Mirror horizontally (M)</span>
        </label>

        <div className="stream-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void createStream()}
            disabled={selectedMediaId === "" || streamLoading || !ready || hasUndisposedStream}
            aria-label="Create offscreen canvas stream"
          >
            {hasUndisposedStream ? "Created" : "Create stream"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runStreamCommand(() => client.send("stream.start", { streamId: streamId ?? "" }))}
            disabled={!canControlStream || !startable || streamLoading}
            aria-label="Start canvas stream rendering"
          >
            Start
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runStreamCommand(() => client.send("stream.stop", { streamId: streamId ?? "" }))}
            disabled={!canControlStream || !stoppable || streamLoading}
            aria-label="Stop canvas stream rendering"
          >
            Stop
          </button>
        </div>

        <div className="stream-actions stream-actions-secondary">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runStreamCommand(() => client.send("stream.restart", { streamId: streamId ?? "" }))}
            disabled={!canControlStream || !restartable || streamLoading}
            aria-label="Restart canvas stream"
          >
            Restart
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runStreamCommand(() => client.send("stream.switchSource", { streamId: streamId ?? "", mediaId: selectedMediaId }))}
            disabled={!canControlStream || !switchable || streamInfo?.sourceMediaId === selectedMediaId || selectedMediaId === "" || streamLoading}
            aria-label="Switch canvas stream source media"
          >
            Switch source
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => void runStreamCommand(() => client.send("stream.dispose", { streamId: streamId ?? "" }))}
            disabled={!canControlStream || streamLoading}
            aria-label="Dispose canvas stream"
          >
            Dispose
          </button>
        </div>

        {streamInfo !== null && (
          <div className="track-inspection" aria-live="polite">
            <div><span>Stream ID</span><code>{streamInfo.streamId ?? "Not created"}</code></div>
            <div><span>Track state</span><strong>{streamInfo.track?.readyState ?? "—"}</strong></div>
            <div><span>Actual settings</span><strong>{formatTrackSettings(streamInfo)}</strong></div>
            {streamInfo.error !== null && (
              <p className="error-message" role="alert">{streamInfo.error.code}: {streamInfo.error.message}</p>
            )}
          </div>
        )}

        {streamError !== null && (
          <ErrorSurface
            title="Stream Error"
            message={streamError}
            actionLabel="Dismiss"
            onAction={() => setStreamError(null)}
            onDismiss={() => setStreamError(null)}
          />
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p className="stream-note">Rendered offscreen in dedicated background document.</p>
          <a className="developer-link" href="./developer-test.html" target="_blank" rel="noreferrer">
            Preview harness ↗
          </a>
        </div>
      </section>

      {/* 5. Playback Transport Section */}
      <section className="section-container playback-section" aria-label="Playback controls">
        <div className="section-heading">
          <div>
            <h2>Playback</h2>
            <p>Timing & transport controls</p>
          </div>
          <StatusRow label="Playback" status={derivedPlaybackStatus} />
        </div>

        <div className="playback-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadPlayback()}
            disabled={selectedMediaId === "" || playbackLoading || !ready}
            aria-label="Load selected media for playback"
          >
            Load
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={playbackCommand("playback.play")}
            disabled={playbackInfo === null || playbackLoading || playbackInfo.state === "PLAYING" || playbackInfo.state === "LOADING" || playbackInfo.state === "ERROR"}
            aria-label="Play video playback"
          >
            Play
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={playbackCommand("playback.pause")}
            disabled={playbackInfo?.state !== "PLAYING" || playbackLoading}
            aria-label="Pause video playback"
          >
            Pause
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={playbackCommand("playback.stop")}
            disabled={playbackInfo === null || playbackLoading || ["STOPPED", "LOADING"].includes(playbackInfo.state)}
            aria-label="Stop video playback"
          >
            Stop
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={playbackCommand("playback.restart")}
            disabled={playbackInfo === null || playbackLoading || ["LOADING", "ERROR"].includes(playbackInfo.state)}
            aria-label="Restart video playback"
          >
            Restart
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => void disposePlayback()}
            disabled={playbackInfo === null || playbackLoading}
            aria-label="Unload playback source"
          >
            Unload
          </button>
        </div>

        <div className="playback-options">
          <label className="check-control" htmlFor="playback-loop-checkbox">
            <input
              id="playback-loop-checkbox"
              type="checkbox"
              checked={playbackInfo?.loop ?? false}
              onChange={(event) => void setPlaybackLoop(event.currentTarget.checked)}
              disabled={playbackInfo === null || playbackLoading}
              aria-label="Loop video playback"
            />
            <span>Loop</span>
          </label>

          <label className="playback-rate-control" htmlFor="playback-speed">
            <span>Speed</span>
            <select
              id="playback-speed"
              className="control-select"
              value={playbackInfo?.playbackRate ?? 1}
              onChange={(event) => void setPlaybackRate(Number(event.currentTarget.value))}
              disabled={playbackInfo === null || playbackLoading}
              aria-label="Select playback speed rate"
            >
              <option value={0.25}>0.25×</option>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={1.25}>1.25×</option>
              <option value={1.5}>1.5×</option>
              <option value={2}>2×</option>
            </select>
          </label>
        </div>

        <div className="playback-seek-row">
          <label htmlFor="playback-seek">Seek</label>
          <input
            id="playback-seek"
            type="range"
            min="0"
            max={playbackInfo?.duration ?? 0}
            step="0.1"
            value={Math.min(playbackSeekDraft ?? playbackInfo?.currentTime ?? 0, playbackInfo?.duration ?? 0)}
            onChange={(event) => setPlaybackSeekDraft(Number(event.currentTarget.value))}
            disabled={playbackInfo?.kind !== "video" || playbackInfo.duration === null || playbackLoading}
            aria-label="Seek video playback position"
          />
          <output aria-live="off">
            {formatPlaybackTime(playbackSeekDraft ?? playbackInfo?.currentTime ?? 0)} / {formatPlaybackTime(playbackInfo?.duration ?? null)}
          </output>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void seekPlayback()}
            disabled={playbackInfo?.kind !== "video" || playbackInfo.duration === null || playbackSeekDraft === null || playbackLoading}
            aria-label="Confirm seek position"
          >
            Seek
          </button>
        </div>

        {playbackInfo?.kind === "image" && (
          <p className="playback-note">
            Image source: Presented as a continuous frame at t=0 until stopped or replaced.
          </p>
        )}

        {playbackError !== null && (
          <ErrorSurface
            title="Playback Error"
            message={playbackError}
            actionLabel="Dismiss"
            onAction={() => setPlaybackError(null)}
            onDismiss={() => setPlaybackError(null)}
          />
        )}

        {playbackInfo?.error !== null && playbackInfo?.error !== undefined && (
          <p className="error-message" role="alert">{playbackInfo.error.code}: {playbackInfo.error.message}</p>
        )}
      </section>

      {/* 6. Camera Integration Section */}
      <section className="section-container camera-section" aria-label="Camera integration controls">
        <div className="section-heading">
          <div>
            <h2>Camera integration</h2>
            <p>Direct CapCam video track into a supported WebRTC sender</p>
          </div>
          <span className={`camera-live-badge ${cameraStatus?.capcamActive === true ? "is-live" : ""}`}>
            {cameraStatus?.capcamActive === true ? "ACTIVE" : "OFF"}
          </span>
        </div>

        <div className="camera-status-grid" aria-live="polite">
          <StatusRow label="WebRTC target" status={cameraConnectionStatus} />
          <StatusRow label="Origin permission" status={cameraStatus?.permission.toUpperCase() ?? "UNKNOWN"} />
          <StatusRow label="Integration" status={cameraStatus?.state ?? "UNKNOWN"} />
          <StatusRow label="Original track" status={cameraStatus?.originalTrackAvailable ? "AVAILABLE" : "—"} />
        </div>

        {cameraStatus?.origin !== null && cameraStatus?.origin !== undefined && (
          <p className="camera-origin">Target origin: <code>{cameraStatus.origin}</code></p>
        )}

        <label className="field-label" htmlFor="camera-source">Camera track source</label>
        <select
          id="camera-source"
          className="control-select"
          value={selectedMediaId}
          onChange={(event) => setSelectedMediaId(event.currentTarget.value)}
          disabled={readyMedia.length === 0 || cameraBusy}
          aria-label="Select source media for camera integration"
        >
          {readyMedia.length === 0 ? (
            <option value="">Upload media first</option>
          ) : (
            readyMedia.map((record) => (
              <option key={record.id} value={record.id}>
                {record.name} · {record.kind.toUpperCase()}
              </option>
            ))
          )}
        </select>

        <div className="camera-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runCameraCommand(() => client.send("camera.detect"))}
            disabled={cameraBusy || cameraGateBlocked}
            aria-label="Check WebRTC target"
          >
            Check target
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void runCameraCommand(() => client.send("camera.enable"))}
            disabled={cameraBusy || !cameraCanEnable}
            aria-label="Turn camera replacement ON"
          >
            Camera ON
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => void runCameraCommand(() => client.send("camera.disable"))}
            disabled={cameraBusy || !cameraCanDisable}
            aria-label="Turn camera replacement OFF and restore track"
          >
            Camera OFF
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runCameraCommand(() => client.send("camera.switchSource", { mediaId: selectedMediaId }))}
            disabled={cameraBusy || !cameraCanDisable || selectedMediaId === ""}
            aria-label="Switch camera track source"
          >
            Switch
          </button>
        </div>

        {cameraGateBlocked ? (
          <p className="camera-note is-blocked" role="note">
            Verification required: Live camera replacement is gated until real Chrome browser verification is performed. No sender track is replaced.
          </p>
        ) : (
          <p className="camera-note">
            Replacement occurs only on explicit command for the detected target origin. CapCam does not emulate a hardware camera.
          </p>
        )}

        {cameraStatus?.reason !== null && cameraStatus?.reason !== undefined && (
          <p className="camera-reason" role="status">
            {humanReadableReason(cameraStatus.reason)}
          </p>
        )}

        {cameraError !== null && (
          <ErrorSurface
            title="Camera Integration Error"
            message={cameraError}
            reason={cameraStatus?.reason}
            actionLabel="Check Target"
            onAction={() => void runCameraCommand(() => client.send("camera.detect"))}
            onDismiss={() => setCameraError(null)}
          />
        )}
      </section>

      {/* 7. Keyboard Shortcuts Modal */}
      <KeyboardHelpModal
        isOpen={showKeyboardHelp}
        onClose={() => setShowKeyboardHelp(false)}
      />

      <footer>Local-only · Extension runtime</footer>
    </main>
  );
}
