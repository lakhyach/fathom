/* Shared Nunatak UI primitives. Bespoke, token-driven, accessible.
   Every control is a real semantic element; every badge pairs colour with
   text; every list has honest loading/empty/error/disconnected states. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { describeError } from "../api/hooks";
import { ConnectionError } from "../api/errors";
import { classificationStatus, stepStatus, workflowStatus, type StatusMeta, type StatusTone } from "../theme/status";
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconSpinner,
  IconX,
} from "../icons";
import { useSettings } from "../state/settings";
import "./ui.css";

/* ----------------------------- status badge ----------------------------- */

export type BadgeKind = "workflow" | "step" | "classification";

function metaFor(kind: BadgeKind, state: string): StatusMeta {
  if (kind === "step") return stepStatus(state);
  if (kind === "classification") return classificationStatus(state);
  return workflowStatus(state);
}

export function StatusBadge({ state, kind = "workflow", size = "md" }: { state: string; kind?: BadgeKind; size?: "sm" | "md" }) {
  const m = metaFor(kind, state);
  return (
    <span className={`fx-badge fx-badge--${m.tone} ${size === "sm" ? "fx-badge--sm" : ""}`} data-tone={m.tone}>
      <span className="fx-badge__dot" aria-hidden="true" />
      {m.icon === "alert" && <IconAlert size={11} className="fx-badge__icon" />}
      <span className="fx-badge__label">{m.label}</span>
    </span>
  );
}

/* -------------------------------- panel --------------------------------- */

export function Panel({
  title,
  kicker,
  actions,
  children,
  className = "",
  bodyClass = "",
  style,
}: {
  title?: ReactNode;
  kicker?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={`panel fx-panel ${className}`} style={style}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-title">
            {kicker && <span className="kicker">{kicker}</span>}
            {title}
          </div>
          {actions && <div className="fx-panel__actions">{actions}</div>}
        </header>
      )}
      <div className={`fx-panel__body ${bodyClass}`}>{children}</div>
    </section>
  );
}

/* ------------------------------ animated count ----------------------------- */

/** Smoothly tweens a number toward `target` whenever it changes (real data).
 *  Uses requestAnimationFrame inside an effect (never during render), so it is
 *  purity-safe. The first mount shows the value directly (no count-from-zero);
 *  later polls animate from the previous value. Honors prefers-reduced-motion
 *  by jumping straight to the target. */
export function useCountUp(target: number, duration = 650): number {
  const [display, setDisplay] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (from === target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const dur = reduce ? 0 : duration;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = dur <= 0 ? 1 : Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}

/* -------------------------------- kpi card -------------------------------- */

/** The one premium metric-card recipe, shared by the Overview command centre
 *  and the execution inspector: eyebrow label, status-tinted icon, a large
 *  tabular figure that eases on real change, an optional caption, a left accent
 *  bar, a hover lift, and a staggered first reveal. */
export function KpiCard({
  kicker,
  value,
  sub,
  icon,
  tone = "neutral",
  index = 0,
}: {
  kicker: string;
  value: number;
  sub?: ReactNode;
  icon: ReactNode;
  tone?: StatusTone | "neutral";
  index?: number;
}) {
  const shown = useCountUp(value);
  return (
    <div
      className={`fx-kpi__card fx-kpi__card--${tone} fx-rise`}
      style={{ "--fx-rise-i": index } as CSSProperties}
    >
      <span className="fx-kpi__k">{kicker}</span>
      <span className="fx-kpi__icon" aria-hidden="true">{icon}</span>
      <span className="fx-kpi__v num">{shown.toLocaleString()}</span>
      {sub && <span className="fx-kpi__sub">{sub}</span>}
    </div>
  );
}

/* ------------------------------ snapshot ts ------------------------------ */

export function SnapshotAt({ updatedAt, className = "" }: { updatedAt: number; className?: string }) {
  const { timeFormat } = useSettings();
  const t = useMemo(() => fmtTime(new Date(updatedAt), timeFormat, true), [updatedAt, timeFormat]);
  return (
    <span className={`fx-snapshot ${className}`} title="Data is a bounded snapshot (no server push stream exists yet)">
      snapshot&nbsp;@&nbsp;<span className="mono">{t}</span>
    </span>
  );
}

/* ------------------------------- time text ------------------------------- */

export function fmtTime(d: Date | null | undefined, mode: "utc" | "local", timeOnly = false): string {
  if (!d) return "—";
  const utc = mode === "utc";
  const opts: Intl.DateTimeFormatOptions = timeOnly
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: utc ? "UTC" : undefined }
    : { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: utc ? "UTC" : undefined };
  let s = new Intl.DateTimeFormat("en-GB", opts).format(d);
  if (utc && !timeOnly) s += " UTC";
  if (utc && timeOnly) s += "Z";
  return s;
}

export function TimeText({ iso, timeOnly = false }: { iso: string | null | undefined; timeOnly?: boolean }) {
  const { timeFormat } = useSettings();
  if (!iso) return <span className="fx-dim">—</span>;
  const d = new Date(iso);
  return <span className="mono fx-time" title={d.toISOString()}>{fmtTime(d, timeFormat, timeOnly)}</span>;
}

/** live "12s ago" ticker — quiet 1s tick only while young; older items static.
 *  The current time is held in state (seeded once) so render stays pure. */
export function RelTime({ iso }: { iso: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const young = iso ? now - Date.parse(iso) < 120_000 : false;
  useEffect(() => {
    if (!young) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [young]);
  if (!iso) return <span className="fx-dim">—</span>;
  const d = new Date(iso);
  return <span className="fx-dim" title={d.toISOString()}>{humanAgo((now - d.getTime()) / 1000)}</span>;
}

export function humanAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function humanDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/* -------------------------------- copy ---------------------------------- */

export function CopyChip({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(value).then(() => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1400);
    });
  }, [value]);
  return (
    <button type="button" className="fx-copy mono" onClick={onCopy} title="Copy to clipboard">
      {label ?? truncate(value, 34)}
      {done ? <IconCheck size={12} className="fx-copy__ok" /> : <IconCopy size={12} />}
      <span className="sr-only">{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ------------------------------ empty/error ------------------------------ */

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="fx-empty fade-up" role="status">
      <div className="fx-empty__icon" aria-hidden="true">{icon ?? <IconCheck size={22} />}</div>
      <p className="fx-empty__title">{title}</p>
      {hint && <p className="fx-empty__hint">{hint}</p>}
      {action && <div className="fx-empty__action">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const v = describeError(error);
  const disconnected = error instanceof ConnectionError || v.kind === "connection";
  return (
    <div className={`fx-error fade-up ${disconnected ? "fx-error--down" : ""}`} role="alert">
      <div className="fx-error__mark" aria-hidden="true">
        {disconnected ? <span className="fx-error__plug" /> : <IconAlert size={18} />}
      </div>
      <div className="fx-error__text">
        <p className="fx-error__headline">{v.headline}</p>
        {v.detail && <p className="fx-error__detail">{v.detail}</p>}
        {v.kind === "auth" && <p className="fx-error__detail">Open <a href="/settings">Settings</a> and present an API key.</p>}
        {v.traceId && (
          <p className="fx-error__trace mono">
            trace {v.traceId}
          </p>
        )}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="fx-loading-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ height: 34, marginBottom: 8, opacity: 1 - i * 0.12 }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/* -------------------------------- modal ---------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // focus trap: first focusable in, Tab cycles inside, Escape closes
    const focusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fx-modal__scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`fx-modal panel ${wide ? "fx-modal--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="fx-modal__head">
          <h2 id={titleId} className="fx-modal__title">{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm fx-modal__x" onClick={onClose} aria-label="Close dialog">
            <IconX size={14} />
          </button>
        </header>
        <div className="fx-modal__body">{children}</div>
        {footer && <footer className="fx-modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------- confirm-with-reason -------------------------- */

/** Every operational verb goes through here: target, consequence, mandatory
 *  reason, and the real endpoint it will hit are all stated before firing. */
export function ConfirmAction({
  title,
  target,
  consequence,
  endpoint,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  target: ReactNode;
  consequence: ReactNode;
  endpoint: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const canFire = reason.trim().length > 0 && !busy;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Discard
          </button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={!canFire} onClick={() => onConfirm(reason.trim())}>
            {busy && <IconSpinner size={13} className="spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="fx-confirm">
        <p className="fx-confirm__row">
          <span className="kicker">Target</span>
          <span>{target}</span>
        </p>
        <p className="fx-confirm__row">
          <span className="kicker">Consequence</span>
          <span>{consequence}</span>
        </p>
        <p className="fx-confirm__row fx-confirm__ep">
          <span className="kicker">Endpoint</span>
          <code className="mono">{endpoint}</code>
        </p>
        <div className="field">
          <label htmlFor="fx-confirm-reason">Reason (required — written to the audit trail)</label>
          <textarea
            id="fx-confirm-reason"
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this action being taken?"
            maxLength={2000}
          />
        </div>
        {error != null && <ErrorState error={error} />}
      </div>
    </Modal>
  );
}

/* -------------------------------- toasts --------------------------------- */

export interface ToastMsg {
  id: number;
  tone: "ok" | "warn" | "bad";
  text: string;
}

const ToastCtx = createContext<(t: Omit<ToastMsg, "id">) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const push = useCallback((t: Omit<ToastMsg, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { ...t, id }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fx-toasts" aria-live="polite" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`fx-toast fx-toast--${t.tone} fade-up`}>
            {t.tone === "ok" ? <IconCheck size={14} /> : t.tone === "bad" ? <IconX size={14} /> : <IconAlert size={14} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ------------------------------ json viewer ------------------------------ */

export function JsonView({ value, collapsed = true }: { value: unknown; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const long = text.length > 120;
  return (
    <div className="fx-json">
      {long && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Collapse" : "Expand"} JSON
        </button>
      )}
      {(!long || open) && <pre className="fx-json__pre mono">{text}</pre>}
    </div>
  );
}

/* ------------------------------- pagination ------------------------------ */

/** Cursor-stack pager over the API's next_cursor contract: forward pushes
 *  the last page's cursor, back pops it; any filter change resets. */
export function useCursorStack() {
  const [stack, setStack] = useState<string[]>([]);
  return useMemo(
    () => ({
      cursor: stack.length > 0 ? stack[stack.length - 1] : undefined,
      depth: stack.length,
      push: (c: string) => setStack((s) => [...s, c]),
      pop: () => setStack((s) => s.slice(0, -1)),
      reset: () => setStack([]),
    }),
    [stack],
  );
}

export function Pager({ depth, onPrev, onNext, hasMore }: { depth: number; onPrev: () => void; onNext: () => void; hasMore: boolean }) {
  return (
    <div className="fx-pager">
      <button type="button" className="btn btn-sm" onClick={onPrev} disabled={depth === 0}>
        Previous
      </button>
      <span className="fx-pager__page">page {depth + 1}</span>
      <button type="button" className="btn btn-sm" onClick={onNext} disabled={!hasMore}>
        Next
      </button>
    </div>
  );
}
