/* Cockpit shell: brand rail, navigation, connection truth, global actions.
   The status cluster reports what the probes actually answer right now —
   never a decorative "all systems go". */
import { NavLink, Outlet, useNavigate } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useHealthz, useReadyz } from "../api/hooks";
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
  FathomMark,
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

  const reachable = !healthz.isError && !healthz.isLoading;
  const ready = readyz.data?.status === "ready";
  const readyReason = readyz.data?.status === "unavailable" ? readyz.data.reason : undefined;

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

  return (
    <div className="fx-shell">
      <a className="skip-link" href="#fx-main">Skip to content</a>

      <header className={`fx-rail ${navOpen ? "fx-rail--open" : ""}`}>
        <div className="fx-rail__brand">
          <FathomMark size={26} />
          <div className="fx-rail__brand-text">
            <span className="fx-rail__name">Fathom</span>
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
          <div className={`fx-conn ${reachable ? (ready ? "fx-conn--ready" : "fx-conn--degraded") : "fx-conn--down"}`} role="status">
            <span className="fx-conn__dot" aria-hidden="true" />
            <div className="fx-conn__text">
              <strong>{!reachable ? "Control plane offline" : ready ? "Engine healthy" : "Engine degraded"}</strong>
              <span>
                {!reachable
                  ? "start `fathom control` or check the proxy"
                  : readyReason === "relay_lag"
                    ? "readyz: relay lag over threshold"
                    : readyReason === "db_unavailable"
                      ? "readyz: database unreachable"
                      : `readyz ${readyz.dataUpdatedAt ? "probed " + new Date(readyz.dataUpdatedAt).toLocaleTimeString() : "…"}`}
              </span>
            </div>
          </div>
          <div className="fx-rail__meta">
            <span className="fx-rail__ver mono">v0.1.0 · local</span>
            <span className={`fx-rail__key ${settings.key ? "fx-rail__key--set" : ""}`}>
              {settings.key ? `key: ${settings.key.label}${settings.key.role ? ` · ${settings.key.role}` : ""}` : "no key presented"}
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
              placeholder="Search workflow id (UUID) or business key (exact)…"
              aria-label="Search workflows by id or exact business key"
            />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="fx-topbar__actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
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
