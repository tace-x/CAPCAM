export interface StatusRowProps {
  label: string;
  status: string;
  detail?: string;
}

export function StatusRow({ label, status, detail }: StatusRowProps) {
  const normalizedStatus = status.toLowerCase();

  return (
    <div className="status-row">
      <span className="status-label">{label}</span>
      <span className={`status-value status-${normalizedStatus}`} title={detail ?? status}>
        <span className="status-indicator" aria-hidden="true" />
        <span className="status-text">{status}</span>
      </span>
    </div>
  );
}
