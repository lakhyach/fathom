/* Workflow explorer. GET /v1/workflows is the only list seam the backend
   serves: keyset paging via next_cursor, plus exact-match `state` and
   `business_key` filters — that is the whole contract, so the filter bar
   offers exactly those two and says so (no fake full-text search). Rows are
   WorkflowSummary: the backend does not send step counts on list rows, so no
   step column is invented (gap honesty). */
import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useMetrics, useWorkflows } from "../api/hooks";
import { workflowCensus } from "../api/prom";
import { WORKFLOW_STATES, toneVar, workflowStatus } from "../theme/status";
import {
  CopyChip,
  EmptyState,
  ErrorState,
  LoadingRows,
  Pager,
  Panel,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
  truncate,
  useCursorStack,
} from "../components/ui";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { IconPlus, IconSearch, IconWorkflows, IconX } from "../icons";
import "./screens.css";

const PAGE_SIZE = 25;

export function Workflows() {
  const [params, setParams] = useSearchParams();
  const businessKey = params.get("business_key") ?? "";
  const [state, setState] = useState("");
  const [creating, setCreating] = useState(false);
  const [keyDraft, setKeyDraft] = useState(businessKey);

  // mirror an externally-changed ?business_key (e.g. the shell search bar) into
  // the input using React's render-time derive pattern — not an effect.
  const [prevKey, setPrevKey] = useState(businessKey);
  if (businessKey !== prevKey) {
    setPrevKey(businessKey);
    setKeyDraft(businessKey);
  }

  const pages = useCursorStack();
  const navigate = useNavigate();
  const query = useMemo(
    () => ({
      state: state || undefined,
      business_key: businessKey || undefined,
      cursor: pages.cursor,
      limit: PAGE_SIZE,
    }),
    [state, businessKey, pages.cursor],
  );

  const list = useWorkflows(query);

  // durable per-state distribution from the engine's own census — annotates the
  // filter chips so the bar doubles as an at-a-glance ledger breakdown.
  const metrics = useMetrics();
  const countByState = useMemo(() => {
    const m = new Map<string, number>();
    if (metrics.data) for (const r of workflowCensus(metrics.data)) m.set(r.state, (m.get(r.state) ?? 0) + r.count);
    return m;
  }, [metrics.data]);
  const censusTotal = [...countByState.values()].reduce((a, b) => a + b, 0);

  const applyKeyFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set("business_key", value.trim());
    else next.delete("business_key");
    setParams(next, { replace: true });
    pages.reset();
  };

  const pickState = (s: string) => {
    setState(s);
    pages.reset();
  };

  const hasRow = list.data && list.data.items.length > 0;

  return (
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Explorer</span>
          <h1>Workflows</h1>
          <p className="fx-page-sub">
            Newest first, keyed by UUIDv7 time ordering. Filters are exact-match — the backend
            offers no fuzzy search, so none is faked here.
          </p>
        </div>
        <div className="fx-page-head__side">
          {list.dataUpdatedAt > 0 && <SnapshotAt updatedAt={list.dataUpdatedAt} />}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <IconPlus size={14} />
            <span>New workflow</span>
          </button>
        </div>
      </div>

      <div className="fx-filters" role="search">
        <form
          className="fx-filters__form"
          onSubmit={(e) => {
            e.preventDefault();
            applyKeyFilter(keyDraft);
          }}
        >
          <IconSearch size={14} />
          <input
            className="input"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="business key — exact match"
            aria-label="Filter by exact business key"
          />
          {businessKey && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => applyKeyFilter("")} aria-label="Clear business key filter">
              <IconX size={12} />
              <span>clear</span>
            </button>
          )}
        </form>

        <div className="fx-filters__chips" role="group" aria-label="Filter by state">
          <button type="button" className={`fx-chip ${state === "" ? "fx-chip--on" : ""}`} onClick={() => pickState("")}>
            All states
            {censusTotal > 0 && <span className="fx-chip__n num">{censusTotal}</span>}
          </button>
          {WORKFLOW_STATES.map((s) => {
            const n = countByState.get(s) ?? 0;
            return (
              <button
                key={s}
                type="button"
                className={`fx-chip fx-chip--state${n === 0 ? " fx-chip--empty" : ""} ${state === s ? "fx-chip--on" : ""}`}
                onClick={() => pickState(s)}
              >
                <span className={`fx-dot fx-dot--${workflowStatus(s).tone}`} aria-hidden="true" />
                {workflowStatus(s).label}
                {n > 0 && <span className="fx-chip__n num">{n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <Panel bodyClass="fx-panel__body--flush" className="fx-rise" style={{ "--fx-rise-i": 0 } as CSSProperties}>
        {list.isLoading && <LoadingRows rows={6} />}
        {list.isError && (
          <div style={{ padding: 16 }}>
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          </div>
        )}
        {list.data && !hasRow && (
          <EmptyState
            icon={<IconWorkflows size={22} />}
            title={businessKey || state ? "Nothing matches these filters" : "No workflows yet"}
            hint={
              businessKey || state
                ? "Widen the state filter or clear the business key to see the full ledger."
                : "Create one with “New workflow” — the engine queues it and a worker claims the first step."
            }
          />
        )}
        {hasRow && (
          <table className="tbl">
            <caption className="sr-only">Workflows, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Definition</th>
                <th scope="col">State</th>
                <th scope="col">Business key</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.items.map((w) => (
                <tr
                  key={w.id}
                  className="fx-link-row fx-row"
                  style={{ "--fx-row-tone": toneVar(workflowStatus(w.state).tone) } as CSSProperties}
                  onClick={() => navigate(`/workflows/${w.id}`)}
                >
                  <td>
                    <Link to={`/workflows/${w.id}`} className="mono fx-cell-id">
                      {truncate(w.id, 20)}…
                    </Link>
                    <span onClick={(e) => e.stopPropagation()}>
                      <CopyChip value={w.id} label="id" />
                    </span>
                  </td>
                  <td>
                    <span className="fx-wfstate">{w.def_name}</span>
                    <div className="fx-cell-id">v{w.def_version}</div>
                  </td>
                  <td>
                    <StatusBadge state={w.state} />
                  </td>
                  <td>
                    <span className="fx-cell-key mono" title={w.business_key}>
                      {w.business_key}
                    </span>
                  </td>
                  <td>
                    <TimeText iso={w.created_at} />
                    <div className="fx-cell-id"><RelTime iso={w.created_at} /></div>
                  </td>
                  <td>
                    <TimeText iso={w.updated_at} />
                    {w.finished_at && <div className="fx-cell-id">finished <TimeText iso={w.finished_at} timeOnly /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hasRow && (
          <div className="fx-panel__foot">
            <Pager
              depth={pages.depth}
              hasMore={!!list.data!.next_cursor}
              onPrev={() => pages.pop()}
              onNext={() => list.data!.next_cursor && pages.push(list.data!.next_cursor)}
            />
          </div>
        )}
      </Panel>

      {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
    </div>
  );
}
