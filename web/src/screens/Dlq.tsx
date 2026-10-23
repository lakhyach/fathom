/* Dead-letter & manual-intervention centre. GET /v1/dlq (open by default)
   feeds the list; the only two W17 exits the machine admits — force-terminate
   and complete-compensation — are the only verbs offered here. Every action
   runs a REAL dry_run preview first (the backend echoes the resulting state
   without mutating), then a confirmed write. retry-now is intentionally NOT
   exposed on a dead letter: the API refuses it and points at the workflow
   resource, so we mirror that truth instead of shipping a button that 422s. */
import { useState } from "react";
import { Link } from "react-router";

import { useDlq, useResolveDlq } from "../api/hooks";
import { useSettings } from "../state/settings";
import { workflowStatus } from "../theme/status";
import {
  ConfirmAction,
  CopyChip,
  EmptyState,
  ErrorState,
  LoadingRows,
  Pager,
  Panel,
  SnapshotAt,
  StatusBadge,
  TimeText,
  truncate,
  useCursorStack,
  useToast,
} from "../components/ui";
import { IconDeadLetter, IconArrowRight, IconUndo } from "../icons";
import type { DeadLetter, ResolveResult } from "../api/types";
import "./screens.css";

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

  return (
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Intervention</span>
          <h1>Dead Letter</h1>
          <p className="fx-page-sub">
            Workflows parked in FAILED · manual await an operator decision. Preview runs a server-side
            dry-run first; the write is a separate, confirmed action recorded to the audit trail.
          </p>
        </div>
        <div className="fx-page-head__side">
          {dlq.dataUpdatedAt > 0 && <SnapshotAt updatedAt={dlq.dataUpdatedAt} />}
        </div>
      </div>

      <div className="fx-filters">
        <div className="fx-filters__chips" role="group" aria-label="Resolution state">
          <button type="button" className={`fx-chip ${openOnly ? "fx-chip--on" : ""}`} onClick={() => { setOpenOnly(true); pages.reset(); }}>
            Open
          </button>
          <button type="button" className={`fx-chip ${!openOnly ? "fx-chip--on" : ""}`} onClick={() => { setOpenOnly(false); pages.reset(); }}>
            All
          </button>
        </div>
        <form
          className="fx-filters__form"
          onSubmit={(e) => { e.preventDefault(); pages.reset(); }}
        >
          <input
            className="input"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            placeholder="class — exact id"
            aria-label="Filter dead letters by class"
            maxLength={64}
          />
        </form>
      </div>

      {!canOperate && (
        <p className="fx-note fx-note--warn" role="status">
          Your key is role <strong>reader</strong>. Resolution buttons are shown but the server answers 403 —
          present an operator key in Settings to act. Hiding the control would only mask the real rule.
        </p>
      )}

      {dlq.isLoading && <Panel><LoadingRows rows={4} /></Panel>}
      {dlq.isError && <Panel><ErrorState error={dlq.error} onRetry={() => dlq.refetch()} /></Panel>}

      {dlq.data && items.length === 0 && (
        <Panel>
          <EmptyState
            icon={<IconDeadLetter size={22} />}
            title={openOnly ? "No open dead letters" : "No dead letters recorded"}
            hint="When a workflow exhausts its retries it lands here for a human. An empty queue is the healthy state."
          />
        </Panel>
      )}

      {items.map((d) => (
        <Panel key={d.id} className="fx-dlq-card">
          <div className="fx-dlq-card__head">
            <span className="fx-dlq-class">{d.class}</span>
            <span className="fx-feed__code mono">{d.reason_code}</span>
            {d.resolved_at ? (
              <span className="fx-dim">resolved · {d.resolution ?? "—"} · <TimeText iso={d.resolved_at} /></span>
            ) : (
              <StatusBadge state="FAILED_MANUAL" size="sm" />
            )}
            <span className="fx-dim" style={{ marginLeft: "auto" }}>created <TimeText iso={d.created_at} /></span>
          </div>

          <div className="fx-feed__meta">
            <span>workflow</span>
            <Link to={`/workflows/${d.workflow_id}`} className="mono fx-link">{truncate(d.workflow_id, 18)}…</Link>
            <CopyChip value={d.workflow_id} label="copy id" />
            {d.step_type && <span>· step <strong>{d.step_type}</strong></span>}
            {d.attempt != null && <span>· attempt {d.attempt}</span>}
          </div>

          {d.detail != null && <pre className="fx-dlq-detail mono">{JSON.stringify(d.detail, null, 2)}</pre>}

          {!d.resolved_at && (
            <div className="fx-dlq-actions">
              <PreviewButton item={d} action="force-terminate" onPreview={setPreview} />
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={!canOperate}
                onClick={() => setConfirming({ item: d, action: "force-terminate" })}
              >
                <IconArrowRight size={13} /> Force terminate
              </button>
              <PreviewButton item={d} action="complete-compensation" onPreview={setPreview} />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!canOperate}
                onClick={() => setConfirming({ item: d, action: "complete-compensation" })}
              >
                <IconUndo size={13} /> Complete compensation
              </button>
            </div>
          )}

          {preview && preview.dead_letter_id === d.id && (
            <div className="fx-preview" role="status">
              <strong>Dry-run preview · {preview.dry_run ? "no change written" : "applied"}</strong>
              <span>
                This workflow would move to <StatusBadge state={preview.state} size="sm" /> at version {preview.version}.
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>Dismiss</button>
            </div>
          )}
        </Panel>
      ))}

      {dlq.data && (
        <Pager
          depth={pages.depth}
          hasMore={!!dlq.data.next_cursor}
          onPrev={() => pages.pop()}
          onNext={() => dlq.data?.next_cursor && pages.push(dlq.data.next_cursor)}
        />
      )}

      {confirming && (
        <ResolveConfirm item={confirming.item} action={confirming.action} onClose={() => setConfirming(null)} />
      )}
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
      <button
        type="button"
        className="btn btn-sm"
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
      </button>
      {view && <span className="fx-dim">{view}</span>}
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
          dead letter <code className="mono">{truncate(item.id, 20)}…</code> on workflow{" "}
          <Link to={`/workflows/${item.workflow_id}`} className="fx-link mono" onClick={onClose}>
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
