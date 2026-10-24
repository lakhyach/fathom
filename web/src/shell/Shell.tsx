/* Nunatak shell — Phase 8 "Verdant Frame".
   The reference composes the product as a device: a forest-lit atmosphere, a
   large near-black frame floating inside it, and a slim neutral rail of icons
   down the left edge. That structure is applied here once, so every route
   inherits it.
   The status cluster reports only what the probes and the presented key
   actually establish right now — never a decorative "all systems go", never a
   fake bell, account menu or theme switch that has no backend. */
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChartLine,
  ChevronDown,
  Copy,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MailWarning,
  Menu,
  Plus,
  ScrollText,
  Search,
  Settings,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";

import { useHealthz, useMetrics, useReadyz } from "../api/hooks";
import { gaugeValue } from "../api/prom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NunatakMark } from "@/components/brand";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { useToast } from "../components/ui";
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
  const toast = useToast();
  const readyz = useReadyz();
  const healthz = useHealthz();
  const metrics = useMetrics();

  const reachable = !healthz.isError && !healthz.isLoading;
  const ready = readyz.data?.status === "ready";
  const readyReason =
    readyz.data?.status === "unavailable" ? readyz.data.reason : undefined;
  const leases = metrics.data
    ? gaugeValue(metrics.data, "fathom_worker_leases_held")
    : null;

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "/" focuses search — the hint printed in the box; ignored while typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
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
    const uuid =
      /^\/?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
        term,
      );
    if (uuid) navigate(`/workflows/${uuid[1]}`);
    else navigate(`/workflows?business_key=${encodeURIComponent(term)}`);
    setQ("");
  };

  const role = settings.key?.role;
  const roleLabel = role
    ? role.charAt(0).toUpperCase() + role.slice(1)
    : "No key";

  const engine = !reachable
    ? { tone: "negative" as const, label: "Control plane offline" }
    : ready
      ? { tone: "completed" as const, label: "Engine healthy" }
      : { tone: "warn" as const, label: "Engine degraded" };
  const detail = !reachable
    ? "start `fathom control` or check the proxy"
    : readyReason === "relay_lag"
      ? "readyz: relay lag over threshold"
      : readyReason === "db_unavailable"
        ? "readyz: database unreachable"
        : ready
          ? "readyz: ready"
          : readyz.dataUpdatedAt
            ? `readyz probed ${new Date(readyz.dataUpdatedAt).toLocaleTimeString()}`
            : "readyz: …";

  const railProps = {
    engineLabel: engine.label,
    engineTone: engine.tone,
    detail,
    leases,
    keyLabel: settings.key ? settings.key.label : null,
    role,
  };

  return (
    <TooltipProvider delayDuration={220}>
      <div className="surface-atmosphere flex h-dvh items-stretch justify-center p-2.5 sm:p-4 lg:p-8 2xl:p-10">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:font-semibold focus:text-primary-foreground"
          href="#nunatak-main"
        >
          Skip to content
        </a>

        <div className="surface-frame flex min-h-0 w-full max-w-[1680px] gap-3 overflow-hidden p-3 sm:gap-4 sm:p-4">
          {/* desktop rail — the reference's slim neutral pill of icons */}
          <aside className="surface-rail hidden w-[74px] shrink-0 flex-col rounded-[22px] p-2 lg:flex">
            <RailContent
              labelled={false}
              onNavigate={() => undefined}
              {...railProps}
            />
          </aside>

          {/* mobile nav sheet: labelled, because a touch target has no tooltip */}
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetContent
              side="left"
              className="surface-rail w-[252px] gap-0 rounded-r-[22px] border-y-0 border-l-0 p-3"
            >
              <RailContent
                labelled
                onNavigate={() => setNavOpen(false)}
                {...railProps}
              />
            </SheetContent>
          </Sheet>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-16 shrink-0 items-center gap-2 px-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground lg:hidden"
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
              >
                <Menu className="size-5" />
              </Button>

              <form
                className="relative flex h-10 min-w-0 max-w-[440px] flex-1 items-center"
                role="search"
                onSubmit={onSearch}
              >
                <Search
                  className="pointer-events-none absolute left-3.5 size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find by id or exact business key…"
                  aria-label="Search workflows by id or exact business key"
                  className="h-10 rounded-full border-border/70 bg-canvas/70 pl-10 text-sm pr-12 transition-colors placeholder:text-muted-foreground/80 focus-visible:border-primary/40 focus-visible:bg-canvas"
                />
                <kbd
                  className="pointer-events-none absolute right-3 rounded-md border border-border/70 bg-chip px-1.5 font-mono text-[10px] text-muted-foreground"
                  aria-hidden="true"
                >
                  /
                </kbd>
              </form>

              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden h-10 gap-2 rounded-full border border-border/70 bg-canvas/60 px-3.5 text-sm font-medium text-muted-foreground hover:bg-canvas hover:text-foreground md:inline-flex"
                  onClick={() => setPalette(true)}
                  aria-label="Open command menu"
                  aria-haspopup="dialog"
                >
                  <Sparkles className="size-4" />
                  Commands
                  <kbd
                    className="rounded-md border border-border/70 bg-chip px-1.5 font-mono text-[10px]"
                    aria-hidden="true"
                  >
                    ⌘K
                  </kbd>
                </Button>

                {/* key identity — the reference's avatar slot, used honestly */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "hidden h-10 items-center gap-2 rounded-full border py-0 pr-2.5 pl-1 transition-colors data-[state=open]:border-primary/45 sm:flex",
                        role
                          ? "border-primary/25 bg-primary/10"
                          : "border-st-warn/35 bg-st-warn/10",
                      )}
                      title={
                        role
                          ? `Presented key acts with the ${role} role`
                          : "No API key presented"
                      }
                    >
                      <span
                        className={cn(
                          "grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold",
                          role
                            ? "bg-primary text-primary-foreground"
                            : "bg-st-warn text-primary-foreground",
                        )}
                      >
                        {role ? roleLabel.charAt(0) : "?"}
                      </span>
                      <span className="flex min-w-0 flex-col leading-tight">
                        <strong className="truncate text-xs font-semibold text-foreground">
                          {roleLabel}
                        </strong>
                        <span className="max-w-28 truncate text-[10px] text-muted-foreground">
                          {settings.key ? settings.key.label : "present a key"}
                        </span>
                      </span>
                      <ChevronDown
                        className="size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuLabel>
                      <span className="block truncate text-[11px] font-normal text-muted-foreground">
                        {settings.key
                          ? `Key label “${settings.key.label}” · ${role ?? "role not declared"}`
                          : "No key presented — /v1 reads answer 401"}
                      </span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => navigate("/settings")}>
                      <Settings2 />
                      Key settings
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!settings.key}
                      onSelect={() => {
                        const label = settings.key?.label ?? "";
                        navigator.clipboard
                          ?.writeText(label)
                          .then(() =>
                            toast({
                              tone: "ok",
                              text: `Key label “${label}” copied`,
                            }),
                          )
                          .catch(() =>
                            toast({
                              tone: "bad",
                              text: "Clipboard unavailable in this browser",
                            }),
                          );
                      }}
                    >
                      <Copy />
                      Copy key label
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!settings.key}
                      onSelect={() => {
                        settings.clearKey();
                        toast({
                          tone: "warn",
                          text: "Presented key cleared from this browser",
                        });
                      }}
                    >
                      <KeyRound />
                      Clear presented key
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  size="sm"
                  className="h-10 rounded-full px-4 font-semibold"
                  onClick={() => setCreating(true)}
                  aria-label="New workflow"
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">New workflow</span>
                  <span className="sm:hidden">New</span>
                </Button>
              </div>
            </header>

            {!settings.key && (
              <div
                className="mx-1 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-st-warn/30 bg-st-warn/10 px-4 py-2.5 text-sm text-foreground/90"
                role="status"
              >
                <span>
                  No API key presented — every{" "}
                  <code className="font-mono text-xs">/v1</code> read will
                  answer 401.
                </span>
                <NavLink to="/settings">
                  <Button variant="outline" size="xs">
                    Present a key
                  </Button>
                </NavLink>
              </div>
            )}

            <main
              id="nunatak-main"
              className="min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-8 outline-none"
              tabIndex={-1}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.22, 0.61, 0.21, 1] }}
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </main>
          </div>
        </div>

        <CommandMenu
          open={palette}
          onClose={() => setPalette(false)}
          onNewWorkflow={() => setCreating(true)}
        />
        {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
      </div>
    </TooltipProvider>
  );
}

/* --------------------------------- the rail -------------------------------- */

function RailContent({
  labelled,
  onNavigate,
  engineLabel,
  engineTone,
  detail,
  leases,
  keyLabel,
  role,
}: {
  labelled: boolean;
  onNavigate: () => void;
  engineLabel: string;
  engineTone: "completed" | "warn" | "negative";
  detail: string;
  leases: number | null;
  keyLabel: string | null;
  role: string | null | undefined;
}) {
  const toneDot = {
    completed: "bg-st-completed",
    warn: "bg-st-warn",
    negative: "bg-st-negative",
  }[engineTone];
  const { pathname } = useLocation();

  const linkClass = (active: boolean) =>
    cn(
      "group relative flex items-center gap-3 rounded-[15px] outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring",
      labelled ? "h-11 w-full pr-3 pl-3 text-sm" : "size-11 justify-center",
      active
        ? "bg-primary font-semibold text-primary-foreground shadow-[0_12px_28px_-10px_oklch(0.735_0.174_140/85%)]"
        : "text-muted-foreground hover:bg-chip hover:text-foreground",
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 py-1">
      <div className="flex shrink-0 items-center gap-2.5 self-stretch">
        <div className="grid size-11 shrink-0 place-items-center rounded-[16px] border border-primary/35 bg-primary/10 shadow-[0_0_24px_-6px_oklch(0.735_0.174_140/55%)]">
          <NunatakMark size={26} />
        </div>
        {labelled ? (
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[15px] font-bold tracking-tight text-foreground">
              Nunatak
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              Workflow Orchestration
            </span>
          </div>
        ) : (
          <span className="sr-only">Nunatak — workflow orchestration</span>
        )}
        {labelled && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto text-muted-foreground"
            onClick={onNavigate}
            aria-label="Close navigation"
          >
            <X />
          </Button>
        )}
      </div>

      <nav
        className={cn(
          "mt-2 flex w-full flex-col gap-1.5",
          !labelled && "items-center",
        )}
        aria-label="Primary"
      >
        {NAV.map(({ to, label, Icon, end }) => {
          // Radix Slot stringifies className, so NavLink's render-function form can't reach it.
          const active = end
            ? pathname === to
            : pathname === to || pathname.startsWith(`${to}/`);
          const linkEl = (
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={linkClass(active)}
            >
              <Icon
                className="size-5 shrink-0"
                strokeWidth={active ? 2.3 : 1.9}
              />
              {labelled && <span className="truncate">{label}</span>}
            </NavLink>
          );
          if (labelled) return <span key={to}>{linkEl}</span>;
          return (
            <Tooltip key={to}>
              <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={10}
                className="rounded-lg bg-popover px-2.5 py-1.5 text-foreground shadow-lg"
              >
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      <div className="mt-auto flex w-full flex-col items-center gap-2 pt-4">
        {labelled ? (
          <div
            className="w-full rounded-[15px] border border-border/60 bg-canvas/60 p-3"
            role="status"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn("size-2 shrink-0 rounded-full", toneDot)}
                aria-hidden="true"
              />
              <strong className="text-xs font-semibold text-foreground">
                {engineLabel}
              </strong>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {detail}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
              {leases === null
                ? "leases —"
                : `${leases} live step lease${leases === 1 ? "" : "s"}`}
            </p>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="status"
                aria-label={`${engineLabel}. ${detail}`}
                className="grid size-11 place-items-center rounded-[15px] border border-border/60 bg-canvas/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="relative grid place-items-center">
                  <Gauge
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-rail",
                      toneDot,
                    )}
                    aria-hidden="true"
                  />
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              sideOffset={10}
              className="max-w-56 rounded-lg bg-popover px-2.5 py-1.5 text-foreground shadow-lg"
            >
              <span className="block font-medium">{engineLabel}</span>
              <span className="block text-xs text-muted-foreground">
                {detail}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">
                {leases === null
                  ? "leases —"
                  : `${leases} live step lease${leases === 1 ? "" : "s"}`}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {labelled && (
          <span
            className={cn(
              "w-full text-center font-mono text-[9px] leading-tight",
              keyLabel ? "text-muted-foreground" : "text-st-warn",
            )}
            title={
              keyLabel
                ? `key: ${keyLabel}${role ? ` · ${role}` : ""}`
                : "no key presented"
            }
          >
            <span className="block max-w-full truncate">
              {keyLabel ?? "no key presented"}
            </span>
            <span className="block">{role ?? "no role"}</span>
          </span>
        )}
      </div>
    </div>
  );
}
