interface KeyboardShortcutItem {
  keyCombo: string;
  description: string;
}

const SHORTCUTS: KeyboardShortcutItem[] = [
  { keyCombo: "Space", description: "Play / Pause video playback" },
  { keyCombo: "R", description: "Restart active playback" },
  { keyCombo: "M", description: "Toggle horizontal stream mirror" },
  { keyCombo: "C", description: "Toggle Camera ON / OFF (when permitted)" },
  { keyCombo: "Esc", description: "Close shortcuts modal / Dismiss errors" },
  { keyCombo: "?", description: "Toggle this keyboard shortcuts cheatsheet" },
];

export interface KeyboardHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardHelpModal({ isOpen, onClose }: KeyboardHelpModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Keyboard Shortcuts</h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close keyboard shortcuts dialog">✕</button>
        </div>
        <div className="modal-content">
          <ul className="shortcuts-list">
            {SHORTCUTS.map((item) => (
              <li key={item.keyCombo} className="shortcut-row">
                <kbd className="shortcut-key">{item.keyCombo}</kbd>
                <span className="shortcut-desc">{item.description}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-footer">
          <span className="shortcuts-note">Shortcuts are active when popup is focused and no input field is active.</span>
        </div>
      </div>
    </div>
  );
}
