/* Create workflow — POST /v1/workflows with a client-generated
   Idempotency-Key (the API's replay gate). Definitions come from the real
   registry; when none are registered the modal says so and points at the
   admin path instead of offering an empty select. */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Braces, ShieldAlert } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { describeError, useCreateWorkflow, useDefinitions } from "../api/hooks";
import { useSettings } from "../state/settings";
import { useToast, Modal, ErrorState, LoadingRows } from "./ui";

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
    !!chosen &&
    bizKey.trim().length > 0 &&
    inputValid &&
    deadline.length > 0 &&
    !create.isPending;

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
          <Button
            variant="outline"
            type="button"
            onClick={onClose}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {create.isPending ? "Queuing…" : "Create instance"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {settings.key?.role === "reader" && (
          <p className="flex items-start gap-2 rounded-lg border border-st-warn/40 bg-st-warn/5 px-3 py-2 text-xs text-st-warn">
            <ShieldAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Your presented key is role{" "}
              <strong className="font-medium">reader</strong> — the API will
              answer 403. An operator key is required.
            </span>
          </p>
        )}

        {defs.isLoading && <LoadingRows rows={2} />}
        {defs.isError && <ErrorState error={defs.error} />}
        {!defs.isLoading && !defs.isError && active.length === 0 && (
          <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            No <strong className="font-medium text-foreground">ACTIVE</strong>{" "}
            definitions are registered. Ask an admin to register one on Settings
            → Definitions (or{" "}
            <code className="font-mono">POST /v1/definitions</code>).
          </p>
        )}

        {!defs.isLoading && active.length > 0 && (
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cw-def">Definition</Label>
              <Select value={defName} onValueChange={setDefName}>
                <SelectTrigger id="cw-def" className="w-full">
                  <SelectValue placeholder="Choose an active definition…" />
                </SelectTrigger>
                <SelectContent>
                  {active.map((d) => (
                    <SelectItem
                      key={`${d.name}@${d.version}`}
                      value={`${d.name}@${d.version}`}
                    >
                      {d.name} @ v{d.version} · {d.steps.length} steps
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chosen && (
                <span className="block text-xs text-muted-foreground">
                  {chosen.steps.length} step
                  {chosen.steps.length === 1 ? "" : "s"} · immutable definition
                  v{chosen.version}
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cw-bk">Business key</Label>
              <Input
                id="cw-bk"
                value={bizKey}
                onChange={(e) => setBizKey(e.target.value)}
                placeholder="order-2026-0001"
                maxLength={128}
              />
              <span className="block text-xs text-muted-foreground">
                One active workflow per key — a duplicate answers 409 while the
                first is still running.
              </span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cw-input" className="flex items-center gap-1.5">
                Instance input (JSON object)
                <Braces
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
              </Label>
              <Textarea
                id="cw-input"
                className="font-mono text-xs"
                rows={5}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                spellCheck={false}
                aria-invalid={!inputValid}
                aria-describedby={inputValid ? undefined : "cw-input-err"}
              />
              {!inputValid && (
                <span
                  id="cw-input-err"
                  role="alert"
                  className="block text-xs text-st-negative"
                >
                  Must be a valid JSON object.
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cw-deadline">Deadline</Label>
              <Input
                id="cw-deadline"
                className="font-mono"
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                Required, and must be in the future — the engine cancels the
                workflow if it has not finished by this instant. Idempotency key{" "}
                <code className="font-mono">{idemKey.slice(0, 13)}…</code> is
                fixed for this dialog.
              </span>
            </div>

            {err && (
              <div className="space-y-1.5">
                <ErrorState error={create.error} />
                {err.kind === "conflict" &&
                  err.currentVersion !== undefined && (
                    <span className="block text-xs text-muted-foreground">
                      current version: {err.currentVersion}
                    </span>
                  )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
