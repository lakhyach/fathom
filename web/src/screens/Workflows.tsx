/* Workflows explorer. The list API (GET /v1/workflows) is the only source; it
   serves keyset paging via next_cursor, plus exact-match `state` and
   `business_key` filters — that is the whole contract, so the filter bar offers
   exactly those two and says so (no fake full-text search). Rows are
   WorkflowSummary: the backend does not send step counts on list rows, so no
   step column is invented (gap honesty).

   Phase 7 rebuild: TanStack Table drives the column model and sorting, shadcn
   Table the markup. Sorting is CLIENT-SIDE over the currently loaded page only
   — the keyset API has no sort parameter — and the footer says exactly that. */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getSortedRowModel,
  useLegacyTable,
  type LegacyColumnDef,
} from "@tanstack/react-table/legacy";
import type { SortingState } from "@tanstack/table-core";
import { ArrowDown, ArrowUp, ChevronsUpDown, Plus, Search, X } from "lucide-react";

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
  PageHeader,
  RelTime,
  SnapshotAt,
  StatusBadge,
  TimeText,
  truncate,
  useCursorStack,
} from "../components/ui";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkflowSummary } from "../api/types";

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
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  // durable per-state distribution from the engine's own census — annotates the
  // filter chips so the bar doubles as an at-a-glance ledger breakdown.
  const metrics = useMetrics();
  const countByState = useMemo(() => {
    const m = new Map<string, number>();
    if (metrics.data) for (const r of workflowCensus(metrics.data)) m.set(r.state, (m.get(r.state) ?? 0) + r.count);
    return m;
  }, [metrics.data]);
  const censusTotal = [...countByState.values()].reduce((a, b) => a + b, 0);

  // definition mix of the LOADED page only — the keyset API has no total
  // count, so the ledger footer states exactly what these rows contain.
  const defMix = useMemo(() => {
    const m = new Map<string, number>();
    if (list.data) for (const w of list.data.items) m.set(w.def_name, (m.get(w.def_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list.data]);

  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<LegacyColumnDef<WorkflowSummary>[]>(
    () => [
      {
        accessorKey: "id",
        header: "Workflow",
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <Link to={`/workflows/${row.original.id}`} className="font-mono text-foreground hover:text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
              {truncate(row.original.id, 20)}…
            </Link>
            <span onClick={(e) => e.stopPropagation()}>
              <CopyChip value={row.original.id} bare />
            </span>
          </div>
        ),
      },
      {
        accessorKey: "def_name",
        header: "Definition",
        cell: ({ row }) => (
          <div>
            <span className="text-foreground">{row.original.def_name}</span>
            <div className="font-mono text-xs text-muted-foreground">v{row.original.def_version}</div>
          </div>
        ),
      },
      {
        accessorKey: "state",
        header: "State",
        cell: ({ row }) => <StatusBadge state={row.original.state} />,
      },
      {
        accessorKey: "business_key",
        header: "Business key",
        cell: ({ row }) => (
          <span className="font-mono text-muted-foreground" title={row.original.business_key}>
            {truncate(row.original.business_key, 28)}
          </span>
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <div>
            <TimeText iso={row.original.created_at} />
            <div className="text-xs text-muted-foreground"><RelTime iso={row.original.created_at} /></div>
          </div>
        ),
      },
      {
        id: "updated",
        accessorFn: (w) => w.updated_at,
        header: "Updated",
        cell: ({ row }) => (
          <div>
            <TimeText iso={row.original.updated_at} />
            {row.original.finished_at && (
              <div className="text-xs text-muted-foreground">finished <TimeText iso={row.original.finished_at} timeOnly /></div>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  const table = useLegacyTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

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

  const hasRow = rows.length > 0;

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        kicker="Explorer"
        title="Workflows"
        sub={<>Newest first, keyed by UUIDv7 time ordering. Filters are exact-match — the backend offers no fuzzy search.</>}
        side={
          <>
            {list.dataUpdatedAt > 0 && <SnapshotAt updatedAt={list.dataUpdatedAt} />}
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              New workflow
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3" role="search">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyKeyFilter(keyDraft);
          }}
        >
          <div className="relative flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              className="pl-9"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="business key — exact match"
              aria-label="Filter by exact business key"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">Apply</Button>
          {businessKey && (
            <Button type="button" variant="ghost" size="sm" onClick={() => applyKeyFilter("")} aria-label="Clear business key filter">
              <X className="size-3.5" />
              clear
            </Button>
          )}
        </form>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by state">
          <StateChip active={state === ""} onClick={() => pickState("")} label="All states" count={censusTotal || undefined} />
          {WORKFLOW_STATES.map((s) => (
            <StateChip
              key={s}
              active={state === s}
              onClick={() => pickState(s)}
              label={workflowStatus(s).label}
              toneVarName={toneVar(workflowStatus(s).tone)}
              count={countByState.get(s) || undefined}
            />
          ))}
        </div>
      </div>

      <Panel bodyClass="p-0">
        {list.isLoading && <div className="p-5"><LoadingRows rows={6} /></div>}
        {list.isError && (
          <div className="p-5">
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          </div>
        )}
        {list.data && !hasRow && (
          <div className="p-5">
            <EmptyState
              icon={<Search className="size-5" />}
              title={businessKey || state ? "Nothing matches these filters" : "No workflows yet"}
              hint={
                businessKey || state
                  ? "Widen the state filter or clear the business key to see the full ledger."
                  : "Create one with “New workflow” — the engine queues it and a worker claims the first step."
              }
            />
          </div>
        )}
        {hasRow && (
          <Table>
            <caption className="sr-only">Workflows, newest first</caption>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead key={header.id} className="text-xs text-muted-foreground uppercase tracking-wide">
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? <ArrowUp className="size-3.5" /> : sorted === "desc" ? <ArrowDown className="size-3.5" /> : <ChevronsUpDown className="size-3.5 opacity-50" />}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  style={{ boxShadow: `inset 3px 0 0 ${toneVar(workflowStatus(row.original.state).tone)}` }}
                  onClick={() => navigate(`/workflows/${row.original.id}`)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {hasRow && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
            <Pager
              depth={pages.depth}
              hasMore={!!list.data!.next_cursor}
              onPrev={() => pages.pop()}
              onNext={() => list.data!.next_cursor && pages.push(list.data!.next_cursor)}
            />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-[0.14em]">Definition mix on this page</span>
              {defMix.map(([d, n]) => (
                <span key={d} className="rounded-full border border-border/60 bg-ice px-2 py-0.5">
                  {d} <b className="font-mono">×{n}</b>
                </span>
              ))}
              <span>
                page shows {rows.length} workflow{rows.length === 1 ? "" : "s"} · sorted columns apply to this page only
              </span>
            </div>
          </div>
        )}
      </Panel>

      {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function StateChip({ active, onClick, label, count, toneVarName }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  toneVarName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active ? "border-primary/40 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
      }`}
    >
      {toneVarName && <span className="size-1.5 rounded-full" style={{ background: toneVarName }} aria-hidden="true" />}
      {label}
      {count !== undefined && <span className="font-mono tabular-nums opacity-70">{count}</span>}
    </button>
  );
}
