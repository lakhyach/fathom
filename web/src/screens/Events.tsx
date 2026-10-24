/* Events & audit explorer. The backend serves audit and inbound feeds ONLY
   per-workflow (GET /workflows/:id/events · /inbound) — there is no global
   event stream (gap G2). So this screen is honest about its scope: pick a
   workflow, then read its ordered audit trail and its classified inbound
   events. No cross-workflow "firehose" is invented.

   Built on: Tailwind layout, kit PageHeader/Panel, shadcn Button/Input,
   lucide glyphs, Radix-free segmented tabs (aria-correct). Data logic unchanged. */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ScrollText, Search } from "lucide-react";

import { useEvents, useInbound, useWorkflows } from "../api/hooks";
import { classificationStatus, toneVar, workflowStatus } from "../theme/status";
import {
  CopyChip,
  EmptyState,
  ErrorState,
  JsonView,
  LoadingRows,
  PageHeader,
  Pager,
  Panel,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
  truncate,
  useCursorStack,
} from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  const audit = useEvents(wf || undefined, {
    cursor: tab === "audit" ? cursor : undefined,
    limit: LIMIT,
  });
  const inbound = useInbound(wf || undefined, {
    cursor: tab === "inbound" ? cursor : undefined,
    limit: LIMIT,
  });
  const active = tab === "audit" ? audit : inbound;

  const pickWorkflow = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("workflow", id);
    else next.delete("workflow");
    setParams(next, { replace: true });
    pages.reset();
  };

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      draft.trim(),
    );

  const auditRows = useMemo(() => audit.data?.items ?? [], [audit.data]);
  const inboundRows = useMemo(() => inbound.data?.items ?? [], [inbound.data]);

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        kicker="Ledger"
        title="Events & Audit"
        sub={
          <>
            Per-workflow transition history and classified ingress. The engine
            exposes no global event stream, so a workflow is chosen first —
            nothing is aggregated across instances.
          </>
        }
        side={
          wf && active.dataUpdatedAt > 0 ? (
            <SnapshotAt updatedAt={active.dataUpdatedAt} />
          ) : undefined
        }
      />

      <Panel className="mb-4" title={<h2>Scope</h2>} kicker="workflow selector">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (isUuid) pickWorkflow(draft.trim());
          }}
        >
          <div className="relative max-w-md flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="pl-9"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paste a workflow UUID…"
              aria-label="Load events for a workflow UUID"
              aria-invalid={draft.trim().length > 0 && !isUuid}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!isUuid}
            onClick={() => pickWorkflow(draft.trim())}
          >
            Load
          </Button>
        </form>

        <div className="mt-4">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Recent
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            {(recent.data?.items ?? []).map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => pickWorkflow(w.id)}
                title={w.id}
                className={`flex w-52 flex-col gap-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  w.id === wf
                    ? "border-primary/40 bg-primary/10"
                    : "border-border/60 hover:border-border hover:bg-accent/40"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-foreground">
                    {w.def_name}
                  </span>
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{
                      background: toneVar(workflowStatus(w.state).tone),
                    }}
                    aria-hidden="true"
                  />
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {truncate(w.business_key || w.id, 24)}
                </span>
                <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{workflowStatus(w.state).label}</span>
                  <RelTime iso={w.updated_at} />
                </span>
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {!wf && (
        <Panel>
          <EmptyState
            icon={<ScrollText className="size-5" />}
            title="No workflow in scope"
            hint="Pick a recent workflow above or paste an id. Audit and inbound events are keyed per instance by the backend."
          />
        </Panel>
      )}

      {wf && (
        <Panel
          title={
            <h2 className="flex items-center gap-2">
              Events · <CopyChip value={wf} label={truncate(wf, 16)} />
            </h2>
          }
          actions={
            <div
              className="inline-flex rounded-lg border border-border/60 p-0.5"
              role="tablist"
              aria-label="Event source"
            >
              <Button
                role="tab"
                aria-selected={tab === "audit"}
                variant={tab === "audit" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => {
                  setTab("audit");
                  pages.reset();
                }}
              >
                Audit trail
                {audit.data && (
                  <span className="ml-1.5 font-mono text-xs opacity-70">
                    {auditRows.length}
                  </span>
                )}
              </Button>
              <Button
                role="tab"
                aria-selected={tab === "inbound"}
                variant={tab === "inbound" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => {
                  setTab("inbound");
                  pages.reset();
                }}
              >
                Inbound events
                {inbound.data && (
                  <span className="ml-1.5 font-mono text-xs opacity-70">
                    {inboundRows.length}
                  </span>
                )}
              </Button>
            </div>
          }
          bodyClass="p-0"
        >
          <div className="px-5 pt-3 pb-1">
            <Link
              to={`/workflows/${wf}`}
              className="text-xs text-primary hover:underline"
            >
              Open execution inspector →
            </Link>
          </div>

          <div className="px-5 py-3">
            {active.isLoading && <LoadingRows rows={5} />}
            {active.isError && (
              <ErrorState
                error={active.error}
                onRetry={() => active.refetch()}
              />
            )}
          </div>

          {tab === "audit" &&
            audit.data &&
            (auditRows.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState
                  title="No audit rows yet"
                  hint="Transitions are written as the engine moves this workflow through its states."
                />
              </div>
            ) : (
              <ul className="flex flex-col">
                {auditRows.map((a) => (
                  <li
                    key={a.seq}
                    className="flex gap-3 border-t border-border/40 px-5 py-3"
                  >
                    <span className="pt-1.5">
                      <span
                        className="block size-2 rounded-full"
                        style={{
                          background: toneVar(workflowStatus(a.to_state).tone),
                        }}
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {a.from_state ? (
                            <>
                              {workflowStatus(a.from_state).label}{" "}
                              <span className="text-muted-foreground">→</span>{" "}
                              {workflowStatus(a.to_state).label}
                            </>
                          ) : (
                            workflowStatus(a.to_state).label
                          )}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {a.reason_code}
                        </span>
                        <StatusBadge
                          state={a.kind}
                          kind="classification"
                          size="sm"
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <TimeText iso={a.created_at} />
                        <span>seq {a.seq}</span>
                        {a.trace_id && (
                          <span className="font-mono">
                            trace {truncate(a.trace_id, 14)}
                          </span>
                        )}
                      </div>
                      {a.detail != null && (
                        <div className="mt-2">
                          <JsonView value={a.detail} />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ))}

          {tab === "inbound" &&
            inbound.data &&
            (inboundRows.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState
                  title="No inbound events recorded"
                  hint="Correlated callbacks and completions land here with their classification."
                />
              </div>
            ) : (
              <ul className="flex flex-col">
                {inboundRows.map((e) => (
                  <li
                    key={e.event_id}
                    className="flex gap-3 border-t border-border/40 px-5 py-3"
                  >
                    <span className="pt-1.5">
                      <span
                        className="block size-2 rounded-full"
                        style={{
                          background: toneVar(
                            classificationStatus(e.classification ?? "").tone,
                          ),
                        }}
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge
                          state={e.classification ?? ""}
                          kind="classification"
                          size="sm"
                        />
                        {e.step_type && (
                          <span className="text-sm font-medium text-foreground">
                            {e.step_type}
                          </span>
                        )}
                        {e.attempt != null && (
                          <span className="font-mono text-xs text-muted-foreground">
                            attempt {e.attempt}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <TimeText iso={e.received_at} />
                        <CopyChip
                          value={e.event_id}
                          label={truncate(e.event_id, 16)}
                        />
                      </div>
                      <div className="mt-2">
                        <JsonView value={e.raw} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ))}

          <div className="border-t border-border/60 px-5 py-3">
            <Pager
              depth={pages.depth}
              hasMore={!!active.data?.next_cursor}
              onPrev={() => pages.pop()}
              onNext={() =>
                active.data?.next_cursor && pages.push(active.data.next_cursor)
              }
            />
          </div>
        </Panel>
      )}
    </div>
  );
}
