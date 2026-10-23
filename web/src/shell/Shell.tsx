/* Cockpit shell: brand rail over bespoke alpine artwork, navigation, connection
   truth, global actions. The status cluster reports only what the probes and the
   presented key actually establish right now — never a decorative "all systems
   go", never a fake bell, account menu or theme switch that has no backend. */
import { NavLink, Outlet, useNavigate } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useHealthz, useMetrics, useReadyz } from "../api/hooks";
import { gaugeValue } from "../api/prom";
import {
  IconDeadLetter,
  IconEvents,
  IconMenu,
  IconMetrics,
  IconOverview,
  IconPlus,
  IconSearch,
  IconSettings,
  IconWorkflows,
  NunatakMark,
  IconX,
} from "../icons";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { useSettings } from "../state/settings";
import "./shell.css";

const NAV = [
  { to: "/", label: "Overview", Icon: IconOverview, end: true },
  { to: "/workflows", label: "Workflows", Icon: IconWorkflows },
  { to: "/dlq", label: "Dead Letter", Icon: IconDeadLetter },
  { to: "/events", label: "Events & Audit", Icon: IconEvents },
  { to: "/metrics", label: "Metrics", Icon: IconMetrics },
  { to: "/settings", label: "Settings", Icon: IconSettings },
];

export function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
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

  return (
    <div className="fx-shell">
      <a className="skip-link" href="#fx-main">Skip to content</a>

      <header className={`fx-rail ${navOpen ? "fx-rail--open" : ""}`}>
        <div className="fx-rail__brand">
          <NunatakMark size={30} />
          <div className="fx-rail__brand-text">
            <span className="fx-rail__name">Nunatak</span>
            <span className="fx-rail__tag">Workflow Orchestration</span>
          </div>
          <button type="button" className="fx-rail__close btn btn-ghost btn-sm" onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <IconX size={14} />
          </button>
        </div>

        <nav className="fx-rail__nav" aria-label="Primary">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) => `fx-navitem ${isActive ? "fx-navitem--active" : ""}`}
            >
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="fx-rail__foot">
          <div className={`fx-engine ${reachable ? (ready ? "fx-engine--ready" : "fx-engine--degraded") : "fx-engine--down"}`} role="status">
            <div className="fx-engine__top">
              <span className="fx-engine__dot" aria-hidden="true" />
              <strong>{!reachable ? "Control plane offline" : ready ? "Engine healthy" : "Engine degraded"}</strong>
            </div>
            <p className="fx-engine__detail">
              {!reachable
                ? "start `fathom control` or check the proxy"
                : readyReason === "relay_lag"
                  ? "readyz: relay lag over threshold"
                  : readyReason === "db_unavailable"
                    ? "readyz: database unreachable"
                    : readyz.data?.status === "ready"
                      ? "readyz: ready"
                      : `readyz ${readyz.dataUpdatedAt ? "probed " + new Date(readyz.dataUpdatedAt).toLocaleTimeString() : "…"}`}
            </p>
            <p className="fx-engine__leases mono">
              {leases === null ? "leases —" : `${leases} live step lease${leases === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="fx-rail__meta">
            <span className="fx-rail__ver mono">v0.1.0 · local</span>
            <span className={`fx-rail__key ${settings.key ? "fx-rail__key--set" : ""}`}>
              {settings.key ? `key: ${settings.key.label}${role ? ` · ${role}` : ""}` : "no key presented"}
            </span>
          </div>
        </div>
      </header>
      {navOpen && <div className="fx-rail__scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}

      <div className="fx-main-col">
        <header className="fx-topbar">
          <button type="button" className="btn btn-ghost btn-sm fx-topbar__burger" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <IconMenu size={18} />
          </button>
          <form className="fx-search" role="search" onSubmit={onSearch}>
            <IconSearch size={14} />
            <input
              ref={searchRef}
              className="fx-search__input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a workflow by id or exact business key…"
              aria-label="Search workflows by id or exact business key"
            />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="fx-topbar__actions">
            <span className={`fx-role fx-role--${role ?? "none"}`} title={role ? `Presented key acts with the ${role} role` : "No API key presented"}>
              <span className="fx-role__avatar" aria-hidden="true">{role ? roleLabel.charAt(0) : "?"}</span>
              <span className="fx-role__text">
                <strong>{roleLabel}</strong>
                <span>{settings.key ? settings.key.label : "present a key"}</span>
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)} aria-label="New workflow">
              <IconPlus size={14} />
              <span>New workflow</span>
            </button>
          </div>
        </header>

        {!settings.key && (
          <div className="fx-keybar" role="status">
            <span>No API key presented — every <code className="mono">/v1</code> read will answer 401.</span>
            <NavLink to="/settings" className="btn btn-sm">
              Present a key
            </NavLink>
          </div>
        )}

        <main id="fx-main" className="fx-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
    </div>
  );
}
