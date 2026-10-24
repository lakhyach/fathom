/* Nunatak shell — Phase 7 rebuild on Glacier Glass (Tailwind v4 + shadcn/Radix
   + Lucide). Sidebar rail, topbar, engine-health footer, global shortcuts and
   the mobile nav sheet. The status cluster reports only what the probes and the
   presented key actually establish right now — never a decorative "all systems
   go", never a fake bell, account menu or theme switch that has no backend. */
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChartLine,
  LayoutDashboard,
  ListChecks,
  MailWarning,
  Menu,
  Plus,
  ScrollText,
  Search,
  Settings,
  X,
} from "lucide-react";

import { useHealthz, useMetrics, useReadyz } from "../api/hooks";
import { gaugeValue } from "../api/prom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { NunatakMark } from "@/components/brand";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { CommandMenu } from "./CommandMenu";
import { useSettings } from "../state/settings";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", Icon: LayoutDashboard, end: true },
  { to: "/workflows", label: "Workflows", Icon: ListChecks },
  { to: "/dlq", label: "Dead Letter", Icon: MailWarning },
  { to: "/events", label: "Events & Audit", Icon: ScrollText },
  { to: "/metrics", label: "Metrics", Icon: ChartLine },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useSettings();
  const readyz = useReadyz();
  const healthz = useHealthz();
  const metrics = useMetrics();

  const reachable = !healthz.isError && !healthz.isLoading;
  const ready = readyz.data?.status === "ready";
  const readyReason = readyz.data?.status === "unavailable" ? readyz.data.reason : undefined;
  const leases = metrics.data ? gaugeValue(metrics.data, "fathom_worker_leases_held") : null;

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "/" focuses search — the hint printed in the box; ignored while typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // ⌘K / Ctrl+K toggles the command menu (works from anywhere, even a field).
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    // The API's only text-ish filter is exact business_key; UUIDs route to detail.
    const uuid = /^\/?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(term);
    if (uuid) navigate(`/workflows/${uuid[1]}`);
    else navigate(`/workflows?business_key=${encodeURIComponent(term)}`);
    setQ("");
  };

  const role = settings.key?.role;
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : "No key";

  const rail = (
    <RailContent
      onNavigate={() => setNavOpen(false)}
      reachable={reachable}
      ready={ready}
      readyReason={readyReason}
      readyzDataUpdatedAt={readyz.dataUpdatedAt}
      leases={leases}
      keyLabel={settings.key ? settings.key.label : null}
      role={role}
    />
  );

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <a className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground" href="#fathom-main">
        Skip to content
      </a>

      {/* desktop rail */}
      <aside className="surface-veil sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border/70 lg:flex">
        {rail}
      </aside>

      {/* mobile nav sheet */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="surface-veil w-[268px] gap-0 border-r border-border/70 p-0">
          {rail}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md sm:px-6">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu className="size-4.5" />
          </Button>
          <form className="relative flex h-8 min-w-0 flex-1 items-center lg:max-w-105" role="search" onSubmit={onSearch}>
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a workflow by id or exact business key…"
              aria-label="Search workflows by id or exact business key"
              className="h-8 bg-input/30 pl-8 text-sm pr-10"
            />
            <kbd className="pointer-events-none absolute right-2.5 rounded border border-border/70 bg-ice px-1.5 font-mono text-[10px] text-muted-foreground" aria-hidden="true">/</kbd>
          </form>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="hidden text-muted-foreground md:inline-flex" onClick={() => setPalette(true)} aria-label="Open command menu" aria-haspopup="dialog">
              <Search className="size-3.5" />
              Commands
              <kbd className="ml-1 rounded border border-border/70 bg-ice px-1.5 font-mono text-[10px]" aria-hidden="true">⌘K</kbd>
            </Button>
            <span
              className={cn(
                "hidden items-center gap-2 rounded-full border py-1 pr-3 pl-1 sm:flex",
                role ? "border-primary/25 bg-primary/8" : "border-st-warn/35 bg-st-warn/8",
              )}
              title={role ? `Presented key acts with the ${role} role` : "No API key presented"}
            >
              <span className={cn("grid size-6 place-items-center rounded-full font-mono text-[11px] font-semibold", role ? "bg-primary text-primary-foreground" : "bg-st-warn text-background")}>
                {role ? roleLabel.charAt(0) : "?"}
              </span>
              <span className="flex flex-col leading-tight">
                <strong className="text-[11px] font-medium text-foreground">{roleLabel}</strong>
                <span className="max-w-28 truncate text-[10px] text-muted-foreground">{settings.key ? settings.key.label : "present a key"}</span>
              </span>
            </span>
            <Button size="sm" onClick={() => setCreating(true)} aria-label="New workflow">
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">New workflow</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </header>

        {!settings.key && (
          <div className="flex items-center justify-between gap-3 border-b border-st-warn/25 bg-st-warn/8 px-4 py-2 text-xs text-foreground/90 sm:px-6" role="status">
            <span>
              No API key presented — every <code className="font-mono text-[11px]">/v1</code> read will answer 401.
            </span>
            <NavLink to="/settings">
              <Button variant="outline" size="xs">Present a key</Button>
            </NavLink>
          </div>
        )}

        <main id="fathom-main" className="min-w-0 flex-1 px-4 py-5 outline-none sm:px-6" tabIndex={-1}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 0.61, 0.21, 1] }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <CommandMenu open={palette} onClose={() => setPalette(false)} onNewWorkflow={() => setCreating(true)} />
      {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
    </div>
  );
}

/* ------------------------------- rail content ------------------------------ */

function RailContent({
  onNavigate,
  reachable,
  ready,
  readyReason,
  readyzDataUpdatedAt,
  leases,
  keyLabel,
  role,
}: {
  onNavigate: () => void;
  reachable: boolean;
  ready: boolean;
  readyReason: string | undefined;
  readyzDataUpdatedAt: number;
  leases: number | null;
  keyLabel: string | null;
  role: string | null | undefined;
}) {
  const engine = !reachable
    ? { dot: "bg-st-negative", text: "text-st-negative", label: "Control plane offline" }
    : ready
      ? { dot: "bg-st-completed", text: "text-st-completed", label: "Engine healthy" }
      : { dot: "bg-st-warn", text: "text-st-warn", label: "Engine degraded" };
  const detail = !reachable
    ? "start `fathom control` or check the proxy"
    : readyReason === "relay_lag"
      ? "readyz: relay lag over threshold"
      : readyReason === "db_unavailable"
        ? "readyz: database unreachable"
        : ready
          ? "readyz: ready"
          : `readyz ${readyzDataUpdatedAt ? "probed " + new Date(readyzDataUpdatedAt).toLocaleTimeString() : "…"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-4">
      <div className="flex items-center gap-2.5 px-1">
        <NunatakMark size={30} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight text-foreground">Nunatak</span>
          <span className="text-[10px] text-muted-foreground">Workflow Orchestration</span>
        </div>
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground lg:hidden" onClick={onNavigate} aria-label="Close navigation">
          <X />
        </Button>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="Primary">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary/12 font-medium text-foreground ring-1 ring-primary/25 ring-inset"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* the hue lives in the graphic; the label stays frost-white so it
                    clears AA on its own tint (measured 3.90 as text-primary) */}
                <Icon className={cn("size-4", isActive && "text-primary")} />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <div className="surface-card rounded-lg p-3" role="status">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", engine.dot)} aria-hidden="true" />
            <strong className={cn("text-xs font-medium", engine.text)}>{engine.label}</strong>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{detail}</p>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
            {leases === null ? "leases —" : `${leases} live step lease${leases === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex flex-col gap-0.5 px-1">
          <span className="font-mono text-[10px] text-muted-foreground">v0.1.0 · local</span>
          <span className={cn("text-[10px]", keyLabel ? "text-muted-foreground" : "text-st-warn")}>
            {keyLabel ? `key: ${keyLabel}${role ? ` · ${role}` : ""}` : "no key presented"}
          </span>
        </div>
      </div>
    </div>
  );
}
