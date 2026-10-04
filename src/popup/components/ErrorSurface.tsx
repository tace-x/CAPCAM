export interface ErrorSurfaceProps {
  title?: string | undefined;
  message: string;
  reason?: string | null | undefined;
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  severity?: "error" | "warning" | undefined;
}

export function ErrorSurface({
  title,
  message,
  reason,
  actionLabel,
  onAction,
  onDismiss,
  severity = "error",
}: ErrorSurfaceProps) {
  return (
    <div className={`error-surface ${severity === "warning" ? "is-warning" : "is-error"}`} role="alert">
      <div className="error-surface-body">
        {title !== undefined && <strong className="error-surface-title">{title}</strong>}
        <p className="error-surface-message">{message}</p>
        {reason !== null && reason !== undefined && reason !== "" && (
          <code className="error-surface-reason">{reason}</code>
        )}
      </div>
      <div className="error-surface-actions">
        {actionLabel !== undefined && onAction !== undefined && (
          <button
            type="button"
            className="error-action-button"
            onClick={onAction}
            aria-label={actionLabel}
          >
            {actionLabel}
          </button>
        )}
        {onDismiss !== undefined && (
          <button
            type="button"
            className="error-dismiss-button"
            onClick={onDismiss}
            aria-label="Dismiss message"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
