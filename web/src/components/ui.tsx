import { Component, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useOutsideClick } from '../hooks.ts';
import { useStore } from '../store.ts';

export function Avatar({ owner, name, size = 18 }: { owner?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (owner && !failed) {
    return (
      <img
        className="avatar"
        style={style}
        src={`https://github.com/${owner}.png?size=${size * 2}`}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="avatar avatar-letter" style={{ ...style, fontSize: size * 0.58 }} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function IconButton({ label, onClick, children, disabled, className }: {
  label: string;
  onClick?: (event: React.MouseEvent) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" className={`icon-button ${className ?? ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A button that opens a floating list of actions. */
export function Menu({ trigger, label, entries, align = 'left', className }: {
  trigger: ReactNode;
  label: string;
  entries: MenuEntry[];
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick(ref, close, open);
  return (
    <div className={`menu-anchor ${className ?? ''}`} ref={ref}>
      <button
        ref={button}
        type="button"
        className="menu-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className={`popover menu-popover menu-${align}`} role="menu">
          {entries.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              className={`menu-item ${entry.danger ? 'danger' : ''}`}
              disabled={entry.disabled}
              onClick={(event) => {
                event.stopPropagation();
                // The item goes with the menu, so a dialog it opens gives focus back to the menu's button.
                button.current?.focus();
                setOpen(false);
                entry.onSelect();
              }}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Dialogs open on top of each other now and then. Only the top one keeps focus to itself.
const openDialogs: HTMLElement[] = [];

/** Where Tab can go in a dialog. A radio group is one stop, at its chosen radio. */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element instanceof HTMLInputElement && element.type === 'radio' && !element.checked) return false;
    return element.getClientRects().length > 0;
  });
}

export function Modal({ title, onClose, children, closeOnBackdrop = true, className }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeOnBackdrop?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // Taken while rendering, before anything inside takes focus with autoFocus.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  // Tab and Shift+Tab go round the dialog rather than out to the page behind it.
  useEffect(() => {
    const own = dialog.current!;
    openDialogs.push(own);
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || openDialogs.at(-1) !== own) return;
      const stops = tabStops(own);
      const active = document.activeElement;
      const inside = active instanceof Node && own.contains(active);
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (!inside || active === stops[0])) {
        event.preventDefault();
        stops.at(-1)!.focus();
      } else if (!event.shiftKey && (!inside || active === stops.at(-1))) {
        event.preventDefault();
        stops[0].focus();
      }
    };
    document.addEventListener('keydown', keepFocus);
    return () => {
      document.removeEventListener('keydown', keepFocus);
      openDialogs.splice(openDialogs.indexOf(own), 1);
      // Back to whatever had focus before, unless that's gone, as a menu item has. Focus that was in the
      // dialog has fallen to the page by now, so anything else holding it was given it on purpose.
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return createPortal(
    <div className={`modal-backdrop ${className ?? ''}`} onMouseDown={(event) => closeOnBackdrop && event.target === event.currentTarget && onClose()}>
      <div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  /** For an action that reaches beyond Lonca, where pressing Enter by habit shouldn't do it. */
  focusCancel?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ title, body, action, danger, focusCancel, onConfirm, onClose }: ConfirmOptions & { onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-body">{body}</div>
      <div className="modal-actions">
        <button type="button" className="button" autoFocus={focusCancel} onClick={onClose}>Cancel</button>
        <button
          type="button"
          autoFocus={!focusCancel}
          className={`button ${danger ? 'button-danger' : 'button-primary'}`}
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((store) => store.toasts);
  const dismiss = useStore((store) => store.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.text}</span>
          <IconButton label="Dismiss" onClick={() => dismiss(toast.id)}><X size={14} /></IconButton>
        </div>
      ))}
    </div>
  );
}

/** Keeps a rendering bug in one screen from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; compact?: boolean }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message === null) return this.props.children;
    if (this.props.compact) return <div className="result-row">This item couldn’t be shown.</div>;
    return (
      <div className="tab-message" role="alert">
        <p>This screen hit an error and couldn’t be shown: {this.state.message}</p>
        <p className="error-actions">
          <button type="button" className="button" onClick={() => location.reload()}>Reload</button>
          <a className="button" href="/">Go home</a>
        </p>
      </div>
    );
  }
}

// The browser turns each spinner itself, like a GIF, so it keeps turning while the page is busy.
// Every spinner's animation counts from the start of the page's clock rather than from when it
// appeared, so all of them show the same angle, and one that remounts doesn't start over at zero.
function alignSpin(element: Element) {
  for (const animation of element.getAnimations()) animation.startTime = 0;
}

export function Spinner({ size = 14 }: { size?: number }) {
  const ring = useRef<SVGSVGElement>(null);
  // Before paint, so a new spinner appears at the shared angle rather than at zero for a frame.
  // The browser makes a new animation when a hidden spinner is shown again or reduced motion is
  // turned off, hence onAnimationStart too, which comes a frame late.
  useLayoutEffect(() => alignSpin(ring.current!), []);
  // One unit is one pixel at every size, so the 1.5px stroke needs no scaling and the arc is a
  // quarter of the ring at every size.
  const centre = size / 2;
  const radius = centre - 0.75;
  return (
    <svg
      ref={ring}
      className="spinner"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Working"
      onAnimationStart={(event) => alignSpin(event.currentTarget)}
    >
      <circle className="spinner-track" cx={centre} cy={centre} r={radius} />
      <circle className="spinner-arc" cx={centre} cy={centre} r={radius} pathLength="100" strokeDasharray="25 75" />
    </svg>
  );
}
