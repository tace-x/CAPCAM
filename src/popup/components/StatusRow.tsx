import type { RuntimeStatus, OffscreenStatus } from "../../shared/types";

type DisplayStatus = RuntimeStatus | OffscreenStatus | "UNKNOWN";

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
