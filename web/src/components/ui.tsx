/* Nunatak shared kit — Phase 7 rebuild on the Glacier Glass system.
   Same public API as the retired fx-* kit so every screen keeps compiling
   while it is rebuilt route by route; the internals are now Tailwind tokens,
   shadcn/ui primitives (Radix), Lucide icons and sonner toasts.
   Every control is a real semantic element; every badge pairs colour with
   text; every list has honest loading/empty/error/disconnected states. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { Check, Copy, LoaderCircle, TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { Toaster } from "./ui/sonner";
import { toast } from "sonner";

import { describeError } from "../api/hooks";
import { ConnectionError } from "../api/errors";
import { classificationStatus, stepStatus, workflowStatus, type StatusMeta, type StatusTone } from "../theme/status";
import { useSettings } from "../state/settings";
/* MIGRATION(M7): only the rebuilt Shell/palette have left ui.css; every legacy
   screen still styles its own markup with .btn/.input/.field/.kicker/.mono from
   ui.css + screens.css. This import retires with those files in M7. */
import "./ui.css";

/* ------------------------------ tone vocabulary ---------------------------- */

/** One tone→class map for the whole app. Static strings so the Tailwind
 *  scanner emits them; colour never travels without the label text. */
export const TONE: Record<StatusTone, { badge: string; dot: string; text: string; soft: string }> = {
  completed:     { badge: "border-st-completed/30 bg-st-completed/10 text-st-completed",     dot: "bg-st-completed",     text: "text-st-completed",     soft: "bg-st-completed/10" },
  running:       { badge: "border-st-running/30 bg-st-running/10 text-st-running",           dot: "bg-st-running",       text: "text-st-running",       soft: "bg-st-running/10" },
  compensating:  { badge: "border-st-compensating/30 bg-st-compensating/10 text-st-compensating", dot: "bg-st-compensating", text: "text-st-compensating", soft: "bg-st-compensating/10" },
  negative:      { badge: "border-st-negative/30 bg-st-negative/10 text-st-negative",         dot: "bg-st-negative",      text: "text-st-negative",      soft: "bg-st-negative/10" },
  manual:        { badge: "border-st-manual/30 bg-st-manual/10 text-st-manual",               dot: "bg-st-manual",        text: "text-st-manual",        soft: "bg-st-manual/10" },
  pending:       { badge: "border-st-pending/30 bg-st-pending/10 text-st-pending",            dot: "bg-st-pending",       text: "text-st-pending",       soft: "bg-st-pending/10" },
  warn:          { badge: "border-st-warn/30 bg-st-warn/10 text-st-warn",                     dot: "bg-st-warn",          text: "text-st-warn",          soft: "bg-st-warn/10" },
};

/* ----------------------------- status badge ----------------------------- */

export type BadgeKind = "workflow" | "step" | "classification";

function metaFor(kind: BadgeKind, state: string): StatusMeta {
  if (kind === "step") return stepStatus(state);
  if (kind === "classification") return classificationStatus(state);
  return workflowStatus(state);
}

export function StatusBadge({ state, kind = "workflow", size = "md", className }: { state: string; kind?: BadgeKind; size?: "sm" | "md"; className?: string }) {
  const m = metaFor(kind, state);
  return (
    <Badge variant="outline" data-tone={m.tone} className={cn(TONE[m.tone].badge, size === "sm" && "px-1.5 py-0 text-[10px]", className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", TONE[m.tone].dot)} aria-hidden="true" />
      {m.icon === "alert" && <TriangleAlert className="size-3" aria-hidden="true" />}
      <span>{m.label}</span>
    </Badge>
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
    <Card className={cn("surface-card gap-0 overflow-hidden py-0", className)} style={style}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-3.5">
          <div className="flex min-w-0 flex-col gap-1">
            {kicker && <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{kicker}</span>}
            <div className="text-sm leading-none font-semibold text-card-foreground">{title}</div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("px-5 py-4", bodyClass)}>{children}</div>
    </Card>
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
 *  bar, a hover lift, and a staggered first reveal (Motion; reduced-motion
 *  users get the instant version via MotionConfig reducedMotion="user"). */
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
  const tint = tone === "neutral" ? null : TONE[tone];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3, ease: [0.22, 0.61, 0.21, 1] }}
      className="surface-card group relative overflow-hidden rounded-xl px-4 py-3.5 transition-transform hover:-translate-y-px motion-reduce:hover:translate-y-0"
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-[3px] rounded-full", tint ? tint.dot : "bg-border")}
      />
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{kicker}</span>
        <span className={cn("text-muted-foreground transition-colors", tint?.text)} aria-hidden="true">{icon}</span>
      </div>
      <div className="mt-1 font-mono text-[28px] leading-none font-semibold tracking-tight text-foreground tabular-nums">
        {shown.toLocaleString()}
      </div>
      {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </motion.div>
  );
}

/* ------------------------------ snapshot ts ------------------------------ */

export function SnapshotAt({ updatedAt, className = "" }: { updatedAt: number; className?: string }) {
  const { timeFormat } = useSettings();
  const t = useMemo(() => fmtTime(new Date(updatedAt), timeFormat, true), [updatedAt, timeFormat]);
  return (
    <span className={cn("text-xs text-muted-foreground", className)} title="Data is a bounded snapshot (no server push stream exists yet)">
      snapshot&nbsp;@&nbsp;<span className="font-mono">{t}</span>
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
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const d = new Date(iso);
  return <span className="font-mono" title={d.toISOString()}>{fmtTime(d, timeFormat, timeOnly)}</span>;
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
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const d = new Date(iso);
  return <span className="text-muted-foreground" title={d.toISOString()}>{humanAgo((now - d.getTime()) / 1000)}</span>;
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

export function CopyChip({ value, label, bare = false }: { value: string; label?: string; bare?: boolean }) {
  const [done, setDone] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(value).then(() => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1400);
    });
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy to clipboard"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-mono text-xs transition-colors",
        bare
          ? "size-6 shrink-0 justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          : "border border-border/60 bg-ice px-2 py-1 text-foreground/90 hover:bg-accent hover:text-foreground",
      )}
    >
      {!bare && <span className="truncate">{label ?? truncate(value, 34)}</span>}
      {done ? <Check className="size-3 text-st-completed" /> : <Copy className="size-3" />}
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
    <div role="status" className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 px-6 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-accent text-muted-foreground" aria-hidden="true">
        {icon ?? <Check className="size-5" />}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const v = describeError(error);
  const disconnected = error instanceof ConnectionError || v.kind === "connection";
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3",
        disconnected ? "border-st-warn/40 bg-st-warn/5" : "border-st-negative/40 bg-st-negative/5",
      )}
    >
      <div aria-hidden="true" className={cn("mt-0.5 shrink-0", disconnected ? "text-st-warn" : "text-st-negative")}>
        {disconnected ? <X className="size-4" /> : <TriangleAlert className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{v.headline}</p>
        {v.detail && <p className="mt-0.5 text-xs text-muted-foreground">{v.detail}</p>}
        {v.kind === "auth" && <p className="mt-0.5 text-xs text-muted-foreground">Open <a className="text-primary underline-offset-4 hover:underline" href="/settings">Settings</a> and present an API key.</p>}
        {v.traceId && <p className="mt-1 font-mono text-[11px] text-muted-foreground">trace {v.traceId}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" style={{ opacity: 1 - i * 0.12 }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/* -------------------------------- modal ---------------------------------- */

/** Radix Dialog: real focus trap, scroll lock, Escape, restore-focus — the
 *  hand-rolled trap in the retired kit is gone. */
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
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={cn("bg-popover", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
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
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Discard
          </Button>
          <Button variant={danger ? "destructive" : "default"} disabled={!canFire} onClick={() => onConfirm(reason.trim())}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] leading-5 text-muted-foreground">Target</span>
          <span className="min-w-0">{target}</span>
        </p>
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] leading-5 text-muted-foreground">Consequence</span>
          <span className="min-w-0">{consequence}</span>
        </p>
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] leading-5 text-muted-foreground">Endpoint</span>
          <code className="min-w-0 rounded bg-ice px-1.5 py-0.5 font-mono text-xs break-all">{endpoint}</code>
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="kit-confirm-reason" className="text-xs font-medium text-foreground">
            Reason (required — written to the audit trail)
          </label>
          <Textarea
            id="kit-confirm-reason"
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

/** Same call signature as the retired kit; renders through sonner so toasts
 *  are one managed stack (swipe-dismiss, pause-on-hover, live region). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const push = useCallback((t: Omit<ToastMsg, "id">) => {
    const opts = { duration: 4600 };
    if (t.tone === "ok") toast.success(t.text, opts);
    else if (t.tone === "bad") toast.error(t.text, opts);
    else toast.warning(t.text, opts);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <Toaster position="bottom-right" toastOptions={{ className: "font-mono" }} />
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
    <div className="flex flex-col gap-1.5">
      {long && (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Collapse" : "Expand"} JSON
        </Button>
      )}
      {(!long || open) && (
        <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-abyss p-3 font-mono text-xs leading-relaxed">{text}</pre>
      )}
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
    <div className="flex items-center gap-3">
      <Button variant="outline" size="sm" onClick={onPrev} disabled={depth === 0}>
        Previous
      </Button>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">page {depth + 1}</span>
      <Button variant="outline" size="sm" onClick={onNext} disabled={!hasMore}>
        Next
      </Button>
    </div>
  );
}

/* ------------------------------- page chrome ------------------------------ */

/** The one page-header recipe every screen shares: eyebrow kicker, title,
 *  honest sub-copy, and a right-hand slot for snapshot stamps / actions. */
export function PageHeader({ kicker, title, sub, side }: { kicker: string; title: ReactNode; sub?: ReactNode; side?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{kicker}</span>
        <h1 className="mt-1 text-2xl leading-none font-semibold tracking-tight text-foreground">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{sub}</p>}
      </div>
      {side && <div className="flex flex-wrap items-center gap-3">{side}</div>}
    </div>
  );
}

/** Readiness as a first-class fact: tone dot + text label, colour never alone. */
export function HealthPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium", TONE[tone].badge)}>
      <span className={cn("size-1.5 rounded-full", TONE[tone].dot)} aria-hidden="true" />
      {label}
    </span>
  );
}
