/* Events & audit explorer. The backend serves audit and inbound feeds ONLY
   per-workflow (GET /workflows/:id/events · /inbound) — there is no global
   event stream (gap G2). So this screen is honest about its scope: pick a
   workflow, then read its ordered audit trail and its classified inbound
   events. No cross-workflow "firehose" is invented. */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { useEvents, useInbound, useWorkflows } from "../api/hooks";
import { classificationStatus, workflowStatus } from "../theme/status";
import {
  CopyChip,
  EmptyState,
  ErrorState,
  JsonView,
  LoadingRows,
  Pager,
  Panel,
  SnapshotAt,
  StatusBadge,
  TimeText,
  truncate,
  useCursorStack,
} from "../components/ui";
import { IconEvents, IconSearch } from "../icons";
import "./screens.css";

const LIMIT = 30;

type Tab = "audit" | "inbound";

export function Events() {
  const [params, setParams] = useSearchParams();
  const wf = params.get("workflow") ?? "";
  const [tab, setTab] = useState<Tab>("audit");
  const [draft, setDraft] = useState(wf);

  const recent = useWorkflows({ limit: 8 });
  const pages = useCursorStack();
  const cursor = pages.cursor;

  const audit = useEvents(wf || undefined, { cursor: tab === "audit" ? cursor : undefined, limit: LIMIT });
  const inbound = useInbound(wf || undefined, { cursor: tab === "inbound" ? cursor : undefined, limit: LIMIT });
  const active = tab === "audit" ? audit : inbound;

  const pickWorkflow = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("workflow", id);
    else next.delete("workflow");
    setParams(next, { replace: true });
    pages.reset();
  };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.trim());

  const auditRows = useMemo(() => audit.data?.items ?? [], [audit.data]);
  const inboundRows = useMemo(() => inbound.data?.items ?? [], [inbound.data]);

  return (
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Ledger</span>
          <h1>Events &amp; Audit</h1>
          <p className="fx-page-sub">
            Per-workflow transition history and classified ingress. The engine exposes no global event
            stream, so a workflow is chosen first — nothing is aggregated across instances.
          </p>
        </div>
        {wf && active.dataUpdatedAt > 0 && <SnapshotAt updatedAt={active.dataUpdatedAt} />}
      </div>

      <Panel title={<h2>Scope</h2>} kicker="workflow selector">
        <div className="fx-filters">
          <form
            className="fx-filters__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (isUuid) pickWorkflow(draft.trim());
            }}
          >
            <IconSearch size={14} />
            <input
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paste a workflow UUID…"
              aria-label="Load events for a workflow UUID"
              aria-invalid={draft.trim().length > 0 && !isUuid}
            />
            <button type="button" className="btn btn-sm" disabled={!isUuid} onClick={() => pickWorkflow(draft.trim())}>
              Load
            </button>
          </form>
        </div>
        <div className="fx-quickpick">
          <span className="kicker">Recent</span>
          {(recent.data?.items ?? []).map((w) => (
            <button
              key={w.id}
              type="button"
              className={`fx-chip ${w.id === wf ? "fx-chip--on" : ""}`}
              onClick={() => pickWorkflow(w.id)}
              title={w.id}
            >
              <span className={`fx-dot fx-dot--${workflowStatus(w.state).tone}`} aria-hidden="true" />
              <span className="mono">{truncate(w.business_key || w.id, 22)}</span>
            </button>
          ))}
        </div>
      </Panel>

      {!wf && (
        <Panel>
          <EmptyState
            icon={<IconEvents size={22} />}
            title="No workflow in scope"
            hint="Pick a recent workflow above or paste an id. Audit and inbound events are keyed per instance by the backend."
          />
        </Panel>
      )}

      {wf && (
        <Panel
          title={<h2 className="fx-mono-head">Events · <CopyChip value={wf} label={truncate(wf, 16)} /></h2>}
          actions={
            <div className="fx-tabs" role="tablist" aria-label="Event source">
              <button role="tab" aria-selected={tab === "audit"} className={`fx-tab ${tab === "audit" ? "fx-tab--on" : ""}`} onClick={() => { setTab("audit"); pages.reset(); }}>
                Audit trail
                {audit.data && <span className="fx-tab__count">{auditRows.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "inbound"} className={`fx-tab ${tab === "inbound" ? "fx-tab--on" : ""}`} onClick={() => { setTab("inbound"); pages.reset(); }}>
                Inbound events
                {inbound.data && <span className="fx-tab__count">{inboundRows.length}</span>}
              </button>
            </div>
          }
          bodyClass="fx-panel__body--flush"
        >
          <div style={{ padding: "10px 16px 0", fontSize: "var(--fx-fs-caption)", color: "var(--fx-ink-faint)" }}>
            <Link to={`/workflows/${wf}`} className="fx-link">Open execution inspector →</Link>
          </div>

          {active.isLoading && <LoadingRows rows={5} />}
          {active.isError && <div style={{ padding: 16 }}><ErrorState error={active.error} onRetry={() => active.refetch()} /></div>}

          {tab === "audit" && audit.data && (
            auditRows.length === 0 ? (
              <EmptyState title="No audit rows yet" hint="Transitions are written as the engine moves this workflow through its states." />
            ) : (
              <ul className="fx-feed">
                {auditRows.map((a) => (
                  <li key={a.seq} className="fx-feed__item">
                    <span className="fx-feed__gutter">
                      <span className={`fx-feed__mark fx-feed__mark--${workflowStatus(a.to_state).tone}`} aria-hidden="true" />
                    </span>
                    <div className="fx-feed__body">
                      <div className="fx-feed__top">
                        <span className="fx-feed__title">
                          {a.from_state ? (
                            <>{workflowStatus(a.from_state).label} <span className="fx-dim">→</span> {workflowStatus(a.to_state).label}</>
                          ) : (
                            <>{workflowStatus(a.to_state).label}</>
                          )}
                        </span>
                        <span className="fx-feed__code mono">{a.reason_code}</span>
                        <span className={`fx-badge fx-badge--sm fx-badge--${classificationStatus(a.kind).tone}`}>
                          <span className="fx-badge__label">{a.kind}</span>
                        </span>
                      </div>
                      <div className="fx-feed__meta">
                        <TimeText iso={a.created_at} />
                        <span className="fx-dim">seq {a.seq}</span>
                        {a.trace_id && <span className="mono fx-dim">trace {truncate(a.trace_id, 14)}</span>}
                      </div>
                      {a.detail != null && <JsonView value={a.detail} />}
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === "inbound" && inbound.data && (
            inboundRows.length === 0 ? (
              <EmptyState title="No inbound events recorded" hint="Correlated callbacks and completions land here with their classification." />
            ) : (
              <ul className="fx-feed">
                {inboundRows.map((e) => (
                  <li key={e.event_id} className="fx-feed__item">
                    <span className="fx-feed__gutter">
                      <span className={`fx-feed__mark fx-feed__mark--${classificationStatus(e.classification).tone}`} aria-hidden="true" />
                    </span>
                    <div className="fx-feed__body">
                      <div className="fx-feed__top">
                        <StatusBadge state={e.classification ?? ""} kind="classification" size="sm" />
                        {e.step_type && <span className="fx-feed__title">{e.step_type}</span>}
                        {e.attempt != null && <span className="fx-feed__code mono">attempt {e.attempt}</span>}
                      </div>
                      <div className="fx-feed__meta">
                        <TimeText iso={e.received_at} />
                        <CopyChip value={e.event_id} label={truncate(e.event_id, 16)} />
                      </div>
                      <JsonView value={e.raw} />
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="fx-panel__foot">
            <Pager
              depth={pages.depth}
              hasMore={!!active.data?.next_cursor}
              onPrev={() => pages.pop()}
              onNext={() => active.data?.next_cursor && pages.push(active.data.next_cursor)}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}
