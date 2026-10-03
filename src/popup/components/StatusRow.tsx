import type { RuntimeStatus, OffscreenStatus, StreamStatus } from "../../shared/types";
import type { PlaybackState } from "../../playback/playback-types";

type DisplayStatus = RuntimeStatus | OffscreenStatus | StreamStatus | PlaybackState | "UNKNOWN";

interface StatusRowProps {
  label: string;
  status: DisplayStatus;
}

export function StatusRow({ label, status }: StatusRowProps) {
  return (
    <div className="status-row">
      <span className="status-label">{label}</span>
      <span className={`status-value status-${status.toLowerCase()}`}>
        <span className="status-indicator" aria-hidden="true" />
        {status}
      </span>
    </div>
  );
}
