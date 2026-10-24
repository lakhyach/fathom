/* Dead-letter & manual-intervention centre. GET /v1/dlq (open by default)
   feeds the list; the only two W17 exits the machine admits — force-terminate
   and complete-compensation — are the only verbs offered here. Every action
   runs a REAL dry_run preview first (the backend echoes the resulting state
   without mutating), then a confirmed write. retry-now is intentionally NOT
   exposed on a dead letter: the API refuses it and points at the workflow
   resource, so we mirror that truth instead of shipping a button that 422s.

   Phase 7 rebuild: Tailwind layout, kit PageHeader/Panel/ConfirmAction, shadcn
   Button, lucide glyphs. All API behaviour and honesty notes are unchanged. */
import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Inbox, Undo2 } from "lucide-react";

import { useDlq, useMetrics, useResolveDlq } from "../api/hooks";
import { byLabel, gaugeValue } from "../api/prom";
import { useSettings } from "../state/settings";
import { workflowStatus } from "../theme/status";
import {
  ConfirmAction,
  CopyChip,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  Pager,
  Panel,
  SnapshotAt,
  StatusBadge,
  TONE,
  TimeText,
  humanDuration,
  truncate,
  useCursorStack,
  useToast,
} from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DeadLetter, ResolveResult } from "../api/types";

const LIMIT = 20;
type Action = "force-terminate" | "complete-compensation";

export function Dlq() {
  const [openOnly, setOpenOnly] = useState(true);
  const [classFilter, setClassFilter] = useState("");
  const pages = useCursorStack();
  const dlq = useDlq({
    open: openOnly,
    class: classFilter || undefined,
    cursor: pages.cursor,
    limit: LIMIT,
  });
  const settings = useSettings();
  const canOperate = settings.key?.role !== "reader";

  const [preview, setPreview] = useState<ResolveResult | null>(null);
  const [confirming, setConfirming] = useState<{ item: DeadLetter; action: Action } | null>(null);

  const items = dlq.data?.items ?? [];

  // durable, engine-authoritative queue signal (not just this page) so the
  // investigation header reflects the real backlog at a glance.
  const metrics = useMetrics();
  const dlqTotal = metrics.data ? byLabel(metrics.data, "fathom_dlq_depth", "class").reduce((a, r) => a + r.value, 0) : null;
  const oldestDlq = metrics.data ? gaugeValue(metrics.data, "fathom_dlq_oldest_age_seconds") : null;
  const openHere = items.filter((d) => !d.resolved_at).length;
  const resolvedHere = items.filter((d) => d.resolved_at).length;

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <PageHeader
        kicker="Intervention"
        title="Dead Letter"
        sub={<>Workflows parked in FAILED · manual await an operator decision. Preview runs a server-side dry-run first; the write is a separate, confirmed action recorded to the audit trail.</>}
        side={dlq.dataUpdatedAt > 0 ? <SnapshotAt updatedAt={dlq.dataUpdatedAt} /> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border/60 p-0.5" role="group" aria-label="Resolution state">
          <Button variant={openOnly ? "secondary" : "ghost"} size="sm" onClick={() => { setOpenOnly(true); pages.reset(); }}>Open</Button>
          <Button variant={!openOnly ? "secondary" : "ghost"} size="sm" onClick={() => { setOpenOnly(false); pages.reset(); }}>All</Button>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); pages.reset(); }}
        >
          <Input
            className="w-56"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            placeholder="class — exact id"
            aria-label="Filter dead letters by class"
            maxLength={64}
          />
        </form>
      </div>

      {!canOperate && (
        <p role="status" className="mb-4 rounded-lg border border-st-warn/40 bg-st-warn/5 px-4 py-3 text-sm text-st-warn">
          Your key is role <strong>reader</strong>. Resolution buttons are shown but the server answers 403 —
          present an operator key in Settings to act. Hiding the control would only mask the real rule.
        </p>
      )}

      {dlq.isLoading && <Panel><LoadingRows rows={4} /></Panel>}
      {dlq.isError && <Panel><ErrorState error={dlq.error} onRetry={() => dlq.refetch()} /></Panel>}

      {dlq.data && items.length === 0 && (
        <Panel>
          <EmptyState
            icon={<Inbox className="size-5" />}
            title={openOnly ? "No open dead letters" : "No dead letters recorded"}
            hint="When a workflow exhausts its retries it lands here for a human. An empty queue is the healthy state."
          />
        </Panel>
      )}

      {dlq.data && items.length > 0 && (
        <div role="status" className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat tone="manual" k="Awaiting decision" v={String(openHere)} s="open on this page" />
          <Stat tone="completed" k="Resolved" v={String(resolvedHere)} s={openOnly ? "hidden by open filter" : "on this page"} />
          <Stat k="Queue depth" v={String(dlqTotal ?? "—")} s="durable · all classes" />
          <Stat k="Oldest open" v={oldestDlq != null ? humanDuration(oldestDlq * 1000) : "—"} s={`page ${pages.depth + 1}`} />
        </div>
      )}

      {items.map((d) => (
        <Panel key={d.id} className={`mb-4 ${d.resolved_at ? "opacity-70" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", TONE.manual.badge)}>{d.class}</span>
            {d.reason_code && d.reason_code !== d.class && (
              <span className="font-mono text-xs text-muted-foreground">{d.reason_code}</span>
            )}
            {d.resolved_at ? (
              <span className="text-xs text-muted-foreground">resolved · {d.resolution ?? "—"} · <TimeText iso={d.resolved_at} /></span>
            ) : (
              <StatusBadge state="FAILED_MANUAL" size="sm" />
            )}
            <span className="ml-auto text-xs text-muted-foreground">created <TimeText iso={d.created_at} /></span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>workflow</span>
            <Link to={`/workflows/${d.workflow_id}`} className="font-mono text-primary hover:underline">{truncate(d.workflow_id, 18)}…</Link>
            <CopyChip value={d.workflow_id} label="copy id" />
            {d.step_type && <span>· step <strong className="text-foreground">{d.step_type}</strong></span>}
            {d.attempt != null && <span>· attempt {d.attempt}</span>}
          </div>

          {d.detail != null && (
            <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border/60 bg-abyss p-3 font-mono text-xs leading-relaxed">{JSON.stringify(d.detail, null, 2)}</pre>
          )}

          {!d.resolved_at && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ActionCard
                icon={<ArrowRight className="size-3.5" />}
                label="Force terminate"
                hint="End the workflow as FAILED now, without running compensation. Already-compensated steps are left as-is."
              >
                <PreviewButton item={d} action="force-terminate" onPreview={setPreview} />
                <Button variant="destructive" size="sm" disabled={!canOperate} onClick={() => setConfirming({ item: d, action: "force-terminate" })}>
                  Terminate
                </Button>
              </ActionCard>
              <ActionCard
                icon={<Undo2 className="size-3.5" />}
                label="Complete compensation"
                hint="Run reverse compensation for completed steps, then settle the workflow as ABORTED."
              >
                <PreviewButton item={d} action="complete-compensation" onPreview={setPreview} />
                <Button variant="outline" size="sm" disabled={!canOperate} onClick={() => setConfirming({ item: d, action: "complete-compensation" })}>
                  Compensate
                </Button>
              </ActionCard>
            </div>
          )}

          {preview && preview.dead_letter_id === d.id && (
            <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
              <strong>Dry-run preview · {preview.dry_run ? "no change written" : "applied"}</strong>
              <span className="text-muted-foreground">
                This workflow would move to <StatusBadge state={preview.state} size="sm" /> at version {preview.version}.
              </span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setPreview(null)}>Dismiss</Button>
            </div>
          )}
        </Panel>
      ))}

      {dlq.data && (
        <div className="mt-4">
          <Pager
            depth={pages.depth}
            hasMore={!!dlq.data.next_cursor}
            onPrev={() => pages.pop()}
            onNext={() => dlq.data?.next_cursor && pages.push(dlq.data.next_cursor)}
          />
        </div>
      )}

      {confirming && (
        <ResolveConfirm item={confirming.item} action={confirming.action} onClose={() => setConfirming(null)} />
      )}
    </div>
  );
}

function Stat({ tone, k, v, s }: { tone?: "manual" | "completed"; k: string; v: string; s: string }) {
  const tint = tone === "manual" ? "text-st-manual" : tone === "completed" ? "text-st-completed" : "text-foreground";
  return (
    <div className="surface-card rounded-xl px-4 py-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{k}</span>
      <div className={`mt-1 font-mono text-2xl leading-none font-semibold tabular-nums ${tint}`}>{v}</div>
      <span className="mt-1 block text-xs text-muted-foreground">{s}</span>
    </div>
  );
}

function ActionCard({ icon, label, hint, children }: { icon: React.ReactNode; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-ice p-3">
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">{icon}{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      <div className="mt-auto flex items-center gap-2 pt-1">{children}</div>
    </div>
  );
}

function PreviewButton({ item, action, onPreview }: {
  item: DeadLetter; action: Action; onPreview: (r: ResolveResult) => void;
}) {
  const resolve = useResolveDlq();
  const [err, setErr] = useState<unknown>(null);
  const view = err ? describePreviewError(err) : null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={resolve.isPending}
        onClick={() => {
          setErr(null);
          resolve.mutate(
            { id: item.id, action, reason: "dry-run preview from cockpit", dry_run: true },
            { onSuccess: (r) => onPreview(r), onError: (e) => setErr(e) },
          );
        }}
      >
        {resolve.isPending ? "Previewing…" : "Preview"}
      </Button>
      {view && <span className="text-xs text-st-negative">{view}</span>}
    </>
  );
}

function describePreviewError(err: unknown): string {
  return err instanceof Error ? err.message : "Preview failed";
}

function ResolveConfirm({ item, action, onClose }: { item: DeadLetter; action: Action; onClose: () => void }) {
  const resolve = useResolveDlq();
  const toast = useToast();
  const consequence =
    action === "force-terminate"
      ? "The workflow is terminated as FAILED without running compensation. Already-compensated steps are left as-is."
      : "The engine runs the reverse compensation for completed steps, then settles the workflow as ABORTED.";
  return (
    <ConfirmAction
      title={action === "force-terminate" ? "Force terminate workflow" : "Complete compensation"}
      target={
        <>
          dead letter <code className="font-mono">{truncate(item.id, 20)}…</code> on workflow{" "}
          <Link to={`/workflows/${item.workflow_id}`} className="font-mono text-primary hover:underline" onClick={onClose}>
            {truncate(item.workflow_id, 20)}…
          </Link>
          {item.step_type ? ` (step ${item.step_type})` : ""}
        </>
      }
      consequence={consequence}
      endpoint={`POST /v1/dlq/${item.id}/actions:resolve`}
      confirmLabel={action === "force-terminate" ? "Terminate" : "Compensate"}
      danger
      busy={resolve.isPending}
      error={resolve.error}
      onClose={onClose}
      onConfirm={(reason) =>
        resolve.mutate(
          { id: item.id, action, reason, dry_run: false },
          {
            onSuccess: (r) => {
              toast({ tone: "ok", text: `Resolved → ${workflowStatus(r.state).label} @ v${r.version}` });
              onClose();
            },
            onError: () => undefined,
          },
        )
      }
    />
  );
}
