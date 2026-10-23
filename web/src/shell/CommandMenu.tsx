/* Nunatak command menu (⌘K / Ctrl+K). Built on cmdk — the same accessible,
   typeahead listbox engine that powers shadcn's Command component, but styled
   entirely with Nunatak tokens so it belongs to this system, not a bolted-on
   demo. Every entry is real: fixed navigation routes, the two genuine global
   actions (New workflow, present a key), and the 8 most-recent workflows read
   from the same live list query the Overview already uses. The result filter is
   client-side over those already-fetched records — it is explicitly NOT a server
   fuzzy search (the API only matches exact business_key), and the footer says so.
   Motion only fades/scales the panel; MotionConfig reducedMotion="user" up the
   tree suppresses the transform for users who ask for less motion. */
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

import { useWorkflows } from "../api/hooks";
import { RelTime, StatusBadge, truncate } from "../components/ui";
import {
  IconChevronRight,
  IconDeadLetter,
  IconEvents,
  IconExecution,
  IconKey,
  IconMetrics,
  IconOverview,
  IconPlus,
  IconSearch,
  IconSettings,
  IconWorkflows,
} from "../icons";
import "./command.css";

const ROUTES = [
  { to: "/", label: "Overview", hint: "Operations command centre", Icon: IconOverview, kw: "dashboard home census pulse" },
  { to: "/workflows", label: "Workflows", hint: "Explorer & filters", Icon: IconWorkflows, kw: "list table explore" },
  { to: "/dlq", label: "Dead Letter", hint: "Incident workspace", Icon: IconDeadLetter, kw: "failures manual intervention resolve" },
  { to: "/events", label: "Events & Audit", hint: "Per-workflow trail", Icon: IconEvents, kw: "audit trail log" },
  { to: "/metrics", label: "Metrics", hint: "Telemetry & health", Icon: IconMetrics, kw: "prometheus health observability" },
  { to: "/settings", label: "Settings", hint: "Keys, probes, definitions", Icon: IconSettings, kw: "config api key register definition" },
];

const EASE: [number, number, number, number] = [0.22, 0.61, 0.21, 1];

export function CommandMenu({
  open,
  onClose,
  onNewWorkflow,
}: {
  open: boolean;
  onClose: () => void;
  onNewWorkflow: () => void;
}) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const recent = useWorkflows({ limit: 8 });
  const items = useMemo(() => recent.data?.items ?? [], [recent.data]);

  // Focus the input on open; restore the trigger's focus on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fx-cmd__scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            className="fx-cmd__panel"
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.18, ease: EASE }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          >
            <Command label="Nunatak command menu" className="fx-cmd__command">
              <div className="fx-cmd__search">
                <IconSearch size={16} />
                <Command.Input
                  className="fx-cmd__input"
                  placeholder="Jump to a page, run an action, open a recent workflow…"
                  aria-label="Search commands"
                />
                <span className="fx-cmd__hint">
                  <kbd>esc</kbd>
                </span>
              </div>

              <Command.List className="fx-cmd__list">
                <Command.Empty className="fx-cmd__empty">No matching command.</Command.Empty>

                <Command.Group heading="Navigate" className="fx-cmd__group">
                  {ROUTES.map(({ to, label, hint, Icon, kw }) => (
                    <Command.Item key={to} className="fx-cmd__item" value={`${label} ${to} ${kw}`} onSelect={() => go(to)}>
                      <span className="fx-cmd__icon">
                        <Icon size={14} />
                      </span>
                      <span className="fx-cmd__main">
                        <span className="fx-cmd__label">{label}</span>
                        <span className="fx-cmd__sub">{hint}</span>
                      </span>
                      <IconChevronRight size={14} className="fx-cmd__chev" />
                    </Command.Item>
                  ))}
                </Command.Group>

                <Command.Group heading="Actions" className="fx-cmd__group">
                  <Command.Item className="fx-cmd__item" value="New workflow create place start" onSelect={() => { onClose(); onNewWorkflow(); }}>
                    <span className="fx-cmd__icon">
                      <IconPlus size={14} />
                    </span>
                    <span className="fx-cmd__main">
                      <span className="fx-cmd__label">New workflow</span>
                      <span className="fx-cmd__sub">Open the placement dialog</span>
                    </span>
                    <IconChevronRight size={14} className="fx-cmd__chev" />
                  </Command.Item>
                  <Command.Item className="fx-cmd__item" value="Present API key settings authenticate role" onSelect={() => go("/settings")}>
                    <span className="fx-cmd__icon">
                      <IconKey size={14} />
                    </span>
                    <span className="fx-cmd__main">
                      <span className="fx-cmd__label">Present an API key</span>
                      <span className="fx-cmd__sub">Bearer key + role, stored in this browser only</span>
                    </span>
                    <IconChevronRight size={14} className="fx-cmd__chev" />
                  </Command.Item>
                </Command.Group>

                {items.length > 0 && (
                  <Command.Group heading={`Recent workflows (${items.length})`} className="fx-cmd__group">
                    {items.map((w) => (
                      <Command.Item
                        key={w.id}
                        className="fx-cmd__item"
                        value={`${w.def_name} ${w.business_key} ${w.state} ${w.id}`}
                        onSelect={() => go(`/workflows/${w.id}`)}
                      >
                        <span className="fx-cmd__icon">
                          <IconExecution size={14} />
                        </span>
                        <span className="fx-cmd__main">
                          <span className="fx-cmd__label">
                            {w.def_name}
                            <span className="fx-cmd__sub"> · {truncate(w.business_key, 26)}</span>
                          </span>
                          <span className="fx-cmd__sub">
                            <span className="fx-cmd__id">{w.id.slice(0, 8)}</span> · <RelTime iso={w.updated_at} />
                          </span>
                        </span>
                        <StatusBadge state={w.state} kind="workflow" size="sm" />
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </Command.List>
            </Command>

            <div className="fx-cmd__foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> select
              </span>
              <span className="grow">
                {items.length > 0
                  ? `Client-side filter over the ${items.length} most-recent workflows — not a server search`
                  : "Recent workflows appear once the list loads"}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
