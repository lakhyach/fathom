/* Create workflow — POST /v1/workflows with a client-generated
   Idempotency-Key (the API's replay gate). Definitions come from the real
   registry; when none are registered the modal says so and points at the
   admin path instead of offering an empty select. */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { describeError, useCreateWorkflow, useDefinitions } from "../api/hooks";
import { useSettings } from "../state/settings";
import { useToast, Modal, ErrorState, LoadingRows } from "./ui";
import { IconJson } from "../icons";

/* datetime-local default: now + 1h, in the browser's local wall clock
   (the client converts to a UTC RFC3339 instant on submit). */
function defaultDeadline(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CreateWorkflowModal({ onClose }: { onClose: () => void }) {
  const defs = useDefinitions();
  const create = useCreateWorkflow();
  const toast = useToast();
  const navigate = useNavigate();
  const settings = useSettings();

  const active = useMemo(
    () => (defs.data ?? []).filter((d) => d.status === "ACTIVE"),
    [defs.data],
  );

  const [defName, setDefName] = useState("");
  const [bizKey, setBizKey] = useState("");
  const [inputText, setInputText] = useState("{}");
  // The API requires a future `deadline` (handlers.go: nil or past ⇒ 422).
  // Prefill a sensible default rather than pretending the field is optional.
  const [deadline, setDeadline] = useState(defaultDeadline);
  // one key per dialog session: retries of THIS intent replay safely, a new
  // dialog is a new intent.
  const [idemKey] = useState(() => crypto.randomUUID());

  const chosen = active.find((d) => `${d.name}@${d.version}` === defName);
  const inputValid = useMemo(() => {
    try {
      const v: unknown = JSON.parse(inputText);
      return v !== null && typeof v === "object" && !Array.isArray(v);
    } catch {
      return false;
    }
  }, [inputText]);

  const canSubmit =
    !!chosen && bizKey.trim().length > 0 && inputValid && deadline.length > 0 && !create.isPending;

  const submit = () => {
    if (!chosen) return;
    create.mutate(
      {
        def_name: chosen.name,
        business_key: bizKey.trim(),
        input: JSON.parse(inputText),
        deadline: new Date(deadline).toISOString(),
        idempotencyKey: idemKey,
      },
      {
        onSuccess: (wf) => {
          toast({ tone: "ok", text: `Workflow ${wf.id.slice(0, 8)}… queued` });
          onClose();
          navigate(`/workflows/${wf.id}`);
        },
        onError: () => undefined, // rendered inline below
      },
    );
  };

  const err = create.error ? describeError(create.error) : null;

  return (
    <Modal
      title="New workflow instance"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {create.isPending ? "Queuing…" : "Create instance"}
          </button>
        </>
      }
    >
      {settings.key?.role === "reader" && (
        <p className="fx-note fx-note--warn">
          Your presented key is role <strong>reader</strong> — the API will answer 403. An operator key is required.
        </p>
      )}

      {defs.isLoading && <LoadingRows rows={2} />}
      {defs.isError && <ErrorState error={defs.error} />}
      {!defs.isLoading && !defs.isError && active.length === 0 && (
        <p className="fx-note">
          No <strong>ACTIVE</strong> definitions are registered. Ask an admin to register one on
          Settings → Definitions (or <code className="mono">POST /v1/definitions</code>).
        </p>
      )}

      {!defs.isLoading && active.length > 0 && (
        <div className="fx-form-grid">
          <div className="field">
            <label htmlFor="cw-def">Definition</label>
            <select
              id="cw-def"
              className="select"
              value={defName}
              onChange={(e) => setDefName(e.target.value)}
            >
              <option value="">Choose {active.length} active…</option>
              {active.map((d) => (
                <option key={`${d.name}@${d.version}`} value={`${d.name}@${d.version}`}>
                  {d.name} @ v{d.version} · {d.steps.length} steps
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="cw-bk">Business key</label>
            <input
              id="cw-bk"
              className="input"
              value={bizKey}
              onChange={(e) => setBizKey(e.target.value)}
              placeholder="order-2026-0001"
              maxLength={128}
            />
            <span className="hint">One active workflow per key — a duplicate answers 409 while the first is still running.</span>
          </div>

          <div className="field">
            <label htmlFor="cw-input">
              Instance input (JSON object) <IconJson size={12} />
            </label>
            <textarea
              id="cw-input"
              className="input mono"
              rows={5}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              spellCheck={false}
              aria-invalid={!inputValid}
            />
            {!inputValid && <span className="err">Must be a valid JSON object.</span>}
          </div>

          <div className="field">
            <label htmlFor="cw-deadline">Deadline</label>
            <input
              id="cw-deadline"
              className="input"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
            <span className="hint">
              Required, and must be in the future — the engine cancels the workflow if it has not finished by this instant.
              Idempotency key <code className="mono">{idemKey.slice(0, 13)}…</code> is fixed for this dialog.
            </span>
          </div>

          {err && (
            <div className="fx-form-grid__err">
              <ErrorState error={create.error} />
              {err.kind === "conflict" && err.currentVersion !== undefined && (
                <span className="hint">current version: {err.currentVersion}</span>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
