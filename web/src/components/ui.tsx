/* Fathom shared kit — the Phase 8 "Verdant Frame" system's only component
   layer. Built on Tailwind v4 tokens, shadcn/ui primitives (Radix), Lucide
   icons and sonner toasts.
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
import { Link } from "react-router";
import {
  Check,
  Copy,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { Toaster } from "./ui/sonner";
import { toast } from "sonner";

import { describeError } from "../api/hooks";
import { AuthError, ConnectionError } from "../api/errors";
import {
  classificationStatus,
  stepStatus,
  workflowStatus,
  type StatusMeta,
  type StatusTone,
} from "../theme/status";
import { useSettings } from "../state/settings";

/* ------------------------------ tone vocabulary ---------------------------- */

/** Engine state → classes. One place, so a badge, a dot and a KPI numeral can
 *  never drift apart. Phase 8 sets the label IN the tone rather than in frost
 *  white: the new ramp was solved so every tone clears AA on its own 10–18%
 *  tint over canvas, card and popover (worst measured pair 4.85:1 at 18% on
 *  --popover, 5.7:1 at the 12% the pill actually uses — see .artifacts/p8).
 *  Colour still never travels alone: the dot and the label co-render. */
export const TONE: Record<
  StatusTone,
  { badge: string; dot: string; text: string; soft: string; glow: string }
> = {
  completed: {
    badge: "border-st-completed/25 bg-st-completed/12 text-st-completed",
    dot: "bg-st-completed",
    text: "text-st-completed",
    soft: "bg-st-completed/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.79_0.165_145/90%)]",
  },
  running: {
    badge: "border-st-running/25 bg-st-running/12 text-st-running",
    dot: "bg-st-running",
    text: "text-st-running",
    soft: "bg-st-running/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.83_0.115_172/90%)]",
  },
  compensating: {
    badge:
      "border-st-compensating/25 bg-st-compensating/12 text-st-compensating",
    dot: "bg-st-compensating",
    text: "text-st-compensating",
    soft: "bg-st-compensating/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.74_0.15_300/90%)]",
  },
  negative: {
    badge: "border-st-negative/25 bg-st-negative/12 text-st-negative",
    dot: "bg-st-negative",
    text: "text-st-negative",
    soft: "bg-st-negative/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.735_0.165_22/90%)]",
  },
  manual: {
    badge: "border-st-manual/25 bg-st-manual/12 text-st-manual",
    dot: "bg-st-manual",
    text: "text-st-manual",
    soft: "bg-st-manual/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.76_0.17_335/90%)]",
  },
  pending: {
    badge: "border-st-pending/25 bg-st-pending/12 text-st-pending",
    dot: "bg-st-pending",
    text: "text-st-pending",
    soft: "bg-st-pending/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.735_0.016_145/70%)]",
  },
  warn: {
    badge: "border-st-warn/25 bg-st-warn/12 text-st-warn",
    dot: "bg-st-warn",
    text: "text-st-warn",
    soft: "bg-st-warn/12",
    glow: "shadow-[0_10px_28px_-16px_oklch(0.845_0.155_85/90%)]",
  },
};

/* ----------------------------- status badge ----------------------------- */

export type BadgeKind = "workflow" | "step" | "classification";

function metaFor(kind: BadgeKind, state: string): StatusMeta {
  if (kind === "step") return stepStatus(state);
  if (kind === "classification") return classificationStatus(state);
  return workflowStatus(state);
}

export function StatusBadge({
  state,
  kind = "workflow",
  size = "md",
  className,
}: {
  state: string;
  kind?: BadgeKind;
  size?: "sm" | "md";
  className?: string;
}) {
  const m = metaFor(kind, state);
  return (
    <Badge
      variant="outline"
      data-tone={m.tone}
      className={cn(
        "rounded-full font-semibold",
        TONE[m.tone].badge,
        size === "sm" ? "px-2 py-0 text-[10px]" : "px-2.5 py-0.5 text-[11px]",
        className,
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", TONE[m.tone].dot)}
        aria-hidden="true"
      />
      {m.icon === "alert" && (
        <TriangleAlert className="size-3" aria-hidden="true" />
      )}
      <span>{m.label}</span>
    </Badge>
  );
}

/* -------------------------------- panel --------------------------------- */

/** Snake_case metric names are one unbreakable token; give the browser a legal
 *  break opportunity at each underscore instead of an arbitrary one. */
function breakable(s: string) {
  return s.replaceAll("_", "_\u200b");
}

export function Panel({
  title,
  kicker,
  source,
  actions,
  children,
  className = "",
  bodyClass = "",
  style,
  lit = false,
}: {
  title?: ReactNode;
  kicker?: string;
  /** the series or endpoint behind this panel — a hover fact, not a headline */
  source?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  style?: CSSProperties;
  /** highlight the surface itself (reference's lit card), not its data */
  lit?: boolean;
}) {
  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden rounded-[20px] py-0",
        lit ? "surface-lit" : "surface-card",
        className,
      )}
      style={style}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-5 py-4">
          <div className="flex min-w-0 basis-auto flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              {title && (
                <div className="truncate text-[15px] leading-none font-semibold text-card-foreground">
                  {title}
                </div>
              )}
              {source && (
                <TooltipProvider delayDuration={180}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        aria-label={`Data source: ${source}`}
                        className="grid size-5 shrink-0 place-items-center rounded-md border border-border/50 bg-chip text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:border-primary/40"
                      >
                        <Info className="size-3" aria-hidden="true" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="max-w-80 font-mono text-[11px] leading-relaxed"
                    >
                      {source}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {kicker && (
              <span className="text-[11px] leading-4 [overflow-wrap:anywhere] text-muted-foreground">
                {kicker}
              </span>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={cn("px-5 py-5", bodyClass)}>{children}</div>
    </Card>
  );
}

/* ------------------------------- segmented -------------------------------- */

/** Single-select pill switch — the reference's time-range control. Built on
 *  Radix ToggleGroup so keyboard and pressed state are real, not imitated. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      aria-label={ariaLabel}
      className={cn(
        "h-9 items-center gap-1 rounded-full border border-border/60 bg-canvas/70 p-1",
        className,
      )}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          size="sm"
          className="h-7 min-w-0 rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-chip hover:text-foreground data-[state=on]:bg-primary data-[state=on]:font-semibold data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/* ------------------------------- metric row -------------------------------- */

/** One labelled fact inside a health/pulse panel: dot + label, mono value,
 *  optional honest caveat underneath. */
export function MetricRow({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-hairline py-2.5 last:border-b-0">
      {tone && (
        <span
          className={cn(
            "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
            TONE[tone].dot,
          )}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 text-sm text-foreground">
        {label}
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-sm text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/* ------------------------------ chart empty ------------------------------- */

/** A chart region with nothing to draw: says so at the height the chart would
 *  have occupied, so the panel never collapses into an unexplained gap. */
export function ChartEmpty({
  height = 240,
  message,
}: {
  height?: number;
  message: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/60 bg-canvas/40 px-6 text-center"
      style={{ height }}
    >
      <span className="text-[11px] text-muted-foreground">
        No data in this window
      </span>
      <span className="max-w-md text-sm leading-relaxed text-muted-foreground">
        {message}
      </span>
    </div>
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
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
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

/** The one premium metric-card recipe, shared by every screen's summary strip:
 *  eyebrow label, a tone-tiled icon, a large tabular figure that eases on real
 *  change, an optional caption or delta pill, a hover lighting response, and a
 *  staggered first reveal (Motion; reduced-motion users get the instant version
 *  via MotionConfig reducedMotion="user"). */
export function KpiCard({
  kicker,
  value,
  sub,
  icon,
  visual,
  artwork,
  accent,
  tone = "neutral",
  index = 0,
  delta,
  href,
}: {
  kicker: string;
  value: number | string;
  sub?: ReactNode;
  icon?: ReactNode;
  /** per-card mini-visualization built from the same real numbers */
  visual?: ReactNode;
  /** decorative, non-data artwork shown behind the factual card content */
  artwork?: ReactNode;
  /** this card's own hue — coordinated with, not identical to, its neighbours */
  accent?: string;
  tone?: StatusTone | "neutral";
  index?: number;
  /** an honest computed comparison, e.g. "3 of 7 terminal" — never a sparkline */
  delta?: ReactNode;
  href?: string;
}) {
  const numeric = typeof value === "number";
  const shown = useCountUp(numeric ? (value as number) : 0);
  const tint = tone === "neutral" ? null : TONE[tone];
  const glow =
    accent ?? (tone === "neutral" ? "var(--primary)" : `var(--st-${tone})`);
  const figure = (
    <>
      <div className="relative mt-2 text-[26px] leading-none font-bold tracking-[-0.03em] text-foreground tabular-nums sm:mt-2.5 sm:text-[30px]">
        {numeric ? shown.toLocaleString() : value}
      </div>
      <div className="relative mt-2 flex flex-wrap items-center gap-2">
        {delta != null && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              tint
                ? TONE[tone as StatusTone].badge
                : "border border-border/70 bg-chip text-muted-foreground",
            )}
          >
            {delta}
          </span>
        )}
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
    </>
  );
  const body = (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: index * 0.05,
        duration: 0.34,
        ease: [0.22, 0.61, 0.21, 1],
      }}
      className={cn(
        "surface-card group relative h-full overflow-hidden rounded-[18px] px-4 py-3.5 transition-all duration-300 @container sm:rounded-[20px] sm:px-5 sm:py-4",
        "hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-[var(--shadow-lift)] motion-reduce:hover:translate-y-0",
        href && "focus-within:border-primary/40",
      )}
    >
      {artwork && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          {artwork}
        </div>
      )}
      {/* each card catches light from its own corner — the reference's cards are
          lit objects, not outlined ones. Opacity lifts on hover. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.11] transition-opacity duration-500 group-hover:opacity-[0.2]"
        style={{
          background: `radial-gradient(115% 130% at 100% 0%, ${glow}, transparent 58%)`,
        }}
      />
      {visual ? (
        <div className="relative flex flex-col gap-3 @[13rem]:flex-row @[13rem]:items-center @[13rem]:gap-4">
          <div className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              {icon && (
                <span
                  aria-hidden="true"
                  className="shrink-0"
                  style={{ color: glow }}
                >
                  {icon}
                </span>
              )}
              <span className="min-w-0">{kicker}</span>
            </span>
            {figure}
          </div>
          <div className="relative w-full max-w-[190px] @[13rem]:w-[44%] @[13rem]:max-w-[168px] @[13rem]:min-w-[104px] @[13rem]:shrink-0 @[13rem]:self-center">
            {visual}
          </div>
        </div>
      ) : (
        <>
          <div className="relative flex items-start justify-between gap-3">
            <span className="min-w-0 text-[11px] leading-5 [overflow-wrap:anywhere] text-muted-foreground">
              {breakable(kicker)}
            </span>
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-[11px] border transition-colors",
                tint
                  ? cn(
                      TONE[tone as StatusTone].soft,
                      TONE[tone as StatusTone].text,
                      "border-border/40",
                    )
                  : "border-border/70 bg-chip text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {icon}
            </span>
          </div>
          {figure}
        </>
      )}
    </motion.div>
  );
  if (!href) return body;
  return (
    <Link
      to={href}
      className="block h-full rounded-[20px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </Link>
  );
}

/* ------------------------------ snapshot ts ------------------------------ */

export function SnapshotAt({
  updatedAt,
  className = "",
}: {
  updatedAt: number;
  className?: string;
}) {
  const { timeFormat } = useSettings();
  const t = useMemo(
    () => fmtTime(new Date(updatedAt), timeFormat, true),
    [updatedAt, timeFormat],
  );
  return (
    <span
      className={cn("text-xs text-muted-foreground", className)}
      title="Data is a bounded snapshot (no server push stream exists yet)"
    >
      snapshot&nbsp;@&nbsp;<span className="font-mono">{t}</span>
    </span>
  );
}

/* ------------------------------- time text ------------------------------- */

export function fmtTime(
  d: Date | null | undefined,
  mode: "utc" | "local",
  timeOnly = false,
): string {
  if (!d) return "—";
  const utc = mode === "utc";
  const opts: Intl.DateTimeFormatOptions = timeOnly
    ? {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: utc ? "UTC" : undefined,
      }
    : {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: utc ? "UTC" : undefined,
      };
  let s = new Intl.DateTimeFormat("en-GB", opts).format(d);
  if (utc && !timeOnly) s += " UTC";
  if (utc && timeOnly) s += "Z";
  return s;
}

export function TimeText({
  iso,
  timeOnly = false,
}: {
  iso: string | null | undefined;
  timeOnly?: boolean;
}) {
  const { timeFormat } = useSettings();
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const d = new Date(iso);
  return (
    <span className="font-mono" title={d.toISOString()}>
      {fmtTime(d, timeFormat, timeOnly)}
    </span>
  );
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
  return (
    <span className="text-muted-foreground" title={d.toISOString()}>
      {humanAgo((now - d.getTime()) / 1000)}
    </span>
  );
}

export function humanAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
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

export function CopyChip({
  value,
  label,
  bare = false,
}: {
  value: string;
  label?: string;
  bare?: boolean;
}) {
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
        "inline-flex items-center gap-1.5 rounded-lg font-mono text-xs transition-colors",
        bare
          ? "size-6 shrink-0 justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          : "border border-border/70 bg-chip px-2 py-1 text-foreground/90 hover:bg-accent hover:text-foreground",
      )}
    >
      {!bare && (
        <span className="truncate">{label ?? truncate(value, 34)}</span>
      )}
      {done ? (
        <Check className="size-3 text-st-completed" />
      ) : (
        <Copy className="size-3" />
      )}
      <span className="sr-only">{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ------------------------------ empty/error ------------------------------ */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-2.5 rounded-[18px] border border-dashed border-border px-6 py-12 text-center"
    >
      <div
        className="grid size-11 place-items-center rounded-2xl border border-border/70 bg-chip text-muted-foreground"
        aria-hidden="true"
      >
        {icon ?? <Check className="size-5" />}
      </div>
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {hint && (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const v = describeError(error);
  const disconnected =
    error instanceof ConnectionError || v.kind === "connection";
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-[16px] border px-4 py-3.5",
        disconnected
          ? "border-st-warn/30 bg-st-warn/10"
          : "border-st-negative/30 bg-st-negative/10",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "mt-0.5 shrink-0",
          disconnected ? "text-st-warn" : "text-st-negative",
        )}
      >
        {disconnected ? (
          <X className="size-4" />
        ) : (
          <TriangleAlert className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{v.headline}</p>
        {v.detail && (
          <p className="mt-0.5 text-xs text-muted-foreground">{v.detail}</p>
        )}
        {v.kind === "auth" && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {error instanceof AuthError && error.kind === "forbidden"
              ? "The role on your presented key does not allow this verb — an operator or admin key is required."
              : "Open Settings and present an API key."}
          </p>
        )}
        {v.traceId && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            trace {v.traceId}
          </p>
        )}
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
    <div role="status" aria-label="Loading" className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          key={i}
          className="h-9 w-full rounded-xl"
          style={{ opacity: 1 - i * 0.12 }}
        />
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
      <DialogContent
        className={cn("rounded-[22px]", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}
      >
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
          <Button
            variant={danger ? "destructive" : "default"}
            disabled={!canFire}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[11px] leading-5 text-muted-foreground">
            Target
          </span>
          <span className="min-w-0">{target}</span>
        </p>
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[11px] leading-5 text-muted-foreground">
            Consequence
          </span>
          <span className="min-w-0">{consequence}</span>
        </p>
        <p className="flex gap-3 text-sm">
          <span className="w-24 shrink-0 text-[11px] leading-5 text-muted-foreground">
            Endpoint
          </span>
          <code className="min-w-0 rounded-lg bg-chip px-1.5 py-0.5 font-mono text-xs break-all">
            {endpoint}
          </code>
        </p>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="kit-confirm-reason"
            className="text-xs font-semibold text-foreground"
          >
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

const ToastCtx = createContext<(t: Omit<ToastMsg, "id">) => void>(
  () => undefined,
);

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
      <Toaster
        position="bottom-right"
        toastOptions={{ className: "font-mono" }}
      />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ------------------------------ json viewer ------------------------------ */

export function JsonView({
  value,
  collapsed = true,
}: {
  value: unknown;
  collapsed?: boolean;
}) {
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
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "Collapse" : "Expand"} JSON
        </Button>
      )}
      {(!long || open) && (
        <pre className="max-h-72 overflow-auto rounded-xl border border-border/70 bg-canvas p-3 font-mono text-xs leading-relaxed">
          {text}
        </pre>
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

export function Pager({
  depth,
  onPrev,
  onNext,
  hasMore,
}: {
  depth: number;
  onPrev: () => void;
  onNext: () => void;
  hasMore: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="rounded-full"
        onClick={onPrev}
        disabled={depth === 0}
      >
        Previous
      </Button>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        page {depth + 1}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="rounded-full"
        onClick={onNext}
        disabled={!hasMore}
      >
        Next
      </Button>
    </div>
  );
}

/* ------------------------------- page chrome ------------------------------ */

/** The one page-header recipe every screen shares: eyebrow kicker, a large
 *  display title in the reference's weight, honest sub-copy, and a right-hand
 *  slot for snapshot stamps / actions. */
export function PageHeader({
  kicker,
  title,
  sub,
  side,
}: {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <span className="text-xs text-muted-foreground">{kicker}</span>
        <h1 className="mt-1.5 text-[30px] leading-none font-bold tracking-[-0.03em] text-foreground">
          {title}
        </h1>
        {sub && (
          <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {sub}
          </p>
        )}
      </div>
      {side && (
        <div className="flex flex-wrap items-center gap-2.5">{side}</div>
      )}
    </div>
  );
}

/** Readiness as a first-class fact: tone dot + text label, colour never alone. */
export function HealthPill({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold",
        TONE[tone].badge,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", TONE[tone].dot)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
