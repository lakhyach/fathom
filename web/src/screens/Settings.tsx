/* Settings & connection diagnostics — Phase 7 rebuild on Glacier Glass.
   The operator presents their API key here (never baked into source); the key
   spec is validated with the SAME parser the backend uses so the displayed role
   hint matches enforcement. Connection diagnostics run the three real
   unauthenticated probes. The definitions panel lists the live registry and —
   for admin keys only — registers a new version, mirroring POST /v1/definitions
   exactly (name, version>=1, steps document). */
import { useMemo, useState } from "react";
import {
  Check,
  Clock,
  Database,
  KeyRound,
  Plug,
  ShieldAlert,
  User,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { useDefinitions, useHealthz, useMetrics, useReadyz, useRegisterDefinition } from "../api/hooks";
import type { Readyz } from "../api/types";
import { parseKeySpec, useSettings, type Role, type TimeFormat } from "../state/settings";
import type { StatusTone } from "../theme/status";
import {
  EmptyState,
  ErrorState,
  JsonView,
  LoadingRows,
  PageHeader,
  Panel,
  TONE,
  TimeText,
  useToast,
} from "../components/ui";

export function Settings() {
  const settings = useSettings();
  const toast = useToast();
  const [draft, setDraft] = useState(settings.keySpec);
  const parsed = useMemo(() => parseKeySpec(draft), [draft]);
  const draftInvalid = draft.trim().length > 0 && parsed === null;

  const saveKey = () => {
    if (settings.setKeySpec(draft)) {
      toast({ tone: "ok", text: "Key applied to this browser session" });
    } else {
      toast({ tone: "bad", text: "Malformed key spec — not saved" });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        kicker="Configuration"
        title="Settings"
        sub="The cockpit is stateless: it stores only this browser’s key and display preference, and reads every fact from the live control plane. Roles are enforced server-side — a reader key cannot write, no matter what this UI shows."
        side={
          <Badge variant="outline" className={cn("gap-1.5", settings.key ? TONE[roleTone(settings.key.role)].badge : TONE.pending.badge)}>
            <KeyRound className="size-3" aria-hidden="true" />
            {settings.key ? settings.key.role : "no key"}
          </Badge>
        }
      />

      <div role="status" className="surface-veil flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <User className="size-3.5" aria-hidden="true" /> identity <strong className="font-medium text-foreground">{settings.key?.label ?? "—"}</strong>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" aria-hidden="true" /> clock <strong className="font-medium text-foreground">{settings.timeFormat === "utc" ? "UTC" : "local"}</strong>
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          stateless · <strong className="font-mono font-medium text-foreground">localStorage</strong> only
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={<h2 className="text-sm font-semibold">API key</h2>} kicker="Authorization: Bearer …">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="key-spec">Key spec</Label>
              <Input
                id="key-spec"
                className="font-mono"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="label:role:key   —   e.g. ops:operator:deadbeef…"
                spellCheck={false}
                aria-invalid={draftInvalid}
                aria-describedby={draftInvalid ? "key-spec-error" : "key-spec-hint"}
                autoComplete="off"
              />
              <span id="key-spec-hint" className="block text-xs text-muted-foreground">
                Accepted shapes: <code className="font-mono">label:role:key</code> (role = reader | operator | admin) or a
                bare key of 8+ chars. Stored only in <code className="font-mono">localStorage</code> for this browser.
              </span>
              {draftInvalid && (
                <span id="key-spec-error" role="alert" className="block text-xs text-st-negative">
                  Does not parse as a valid key spec.
                </span>
              )}
              {parsed && (
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  will present as
                  <span className="font-medium text-foreground">
                    {parsed.label} · role {parsed.role ?? "unknown"} ·{" "}
                    <span className="font-mono">{parsed.token.slice(0, 4)}…{parsed.token.length > 4 ? parsed.token.slice(-2) : ""}</span>
                  </span>
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={draftInvalid} onClick={saveKey}>
                <KeyRound data-slot="icon" /> Apply key
              </Button>
              {settings.keySpec && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { settings.clearKey(); setDraft(""); toast({ tone: "warn", text: "Key cleared" }); }}
                >
                  <X data-slot="icon" /> Clear
                </Button>
              )}
            </div>

            <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Current session:{" "}
              {settings.key ? (
                <>
                  <strong className="font-medium text-foreground">{settings.key.label}</strong> · role {settings.key.role ?? "unknown"}
                </>
              ) : (
                "no key presented — /v1 reads will 401."
              )}
            </p>
          </div>
        </Panel>

        <Panel title={<h2 className="text-sm font-semibold">Connection</h2>} kicker="live probes (unauthenticated)">
          <ConnectionDiagnostics />
          <div className="mt-4 space-y-2 border-t border-border/60 pt-4">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Time format</span>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={2}
              value={settings.timeFormat}
              onValueChange={(v) => { if (v) settings.setTimeFormat(v as TimeFormat); }}
            >
              <ToggleGroupItem value="utc" className="gap-1.5 text-xs">
                <Clock data-slot="icon" /> UTC (24 h)
              </ToggleGroupItem>
              <ToggleGroupItem value="local" className="gap-1.5 text-xs">
                <Clock data-slot="icon" /> Browser local
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              Applies to every timestamp in the cockpit. Now: <TimeText iso={new Date().toISOString()} />
            </p>
          </div>
        </Panel>
      </div>

      <DefinitionsPanel canRegister={settings.key?.role === "admin"} hasKey={!!settings.key} />
    </div>
  );
}

function roleTone(role?: Role | null): StatusTone {
  if (role === "admin") return "completed";
  if (role === "operator") return "running";
  return "pending";
}

/* --------------------------------- probes --------------------------------- */

interface Probe {
  isLoading: boolean;
  isError: boolean;
  data?: unknown;
  refetch: () => unknown;
}

function ConnectionDiagnostics() {
  const healthz = useHealthz();
  const readyz = useReadyz();
  const metrics = useMetrics();

  return (
    <div className="space-y-2">
      <ProbeRow label="Liveness" path="GET /healthz" q={healthz} />
      <ProbeRow label="Readiness" path="GET /readyz" q={readyz} />
      <ProbeRow label="Metrics" path="GET /metrics" q={metrics} />
      <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
        <Plug className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Requests are same-origin and reach the API through the dev proxy
          (<code className="font-mono">FATHOM_API_TARGET</code>). No CORS origin is configured server-side, so the
          cockpit must be served from the proxy, not a separate host.
        </span>
      </p>
    </div>
  );
}

function ProbeRow({ label, path, q }: { label: string; path: string; q: Probe }) {
  /* A transport error is red; but /readyz answers a VALID 503 body when the
     engine is degraded (relay lag), so readiness reflects the parsed status,
     not mere reachability — a green dot would contradict the copy. */
  const ready = label === "Readiness" ? (q.data as Readyz | undefined) : undefined;
  const tone: StatusTone = q.isLoading
    ? "pending"
    : q.isError
      ? "negative"
      : ready?.status === "unavailable"
        ? "warn"
        : "completed";

  let detail = "ok";
  if (q.isLoading) detail = "probing…";
  else if (q.isError) detail = "unreachable";
  else if (ready) detail = ready.reason ? `readyz: ${ready.status} · ${ready.reason}` : `readyz: ${ready.status}`;
  else if (label === "Metrics") detail = `${Object.keys((q.data as Record<string, unknown>) ?? {}).length} families`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <span className={cn("inline-flex items-center gap-2 text-sm font-medium", TONE[tone].text)}>
        <span className={cn("size-1.5 rounded-full", TONE[tone].dot, q.isLoading && "animate-pulse")} aria-hidden="true" />
        {label}
      </span>
      <code className="font-mono text-[11px] text-muted-foreground">{path}</code>
      <span className="ml-auto font-mono text-[11px] text-muted-foreground">{detail}</span>
      <Button type="button" variant="ghost" size="xs" onClick={() => q.refetch()}>
        Re-probe
      </Button>
    </div>
  );
}

/* ------------------------------- definitions ------------------------------ */

const DEFAULT_STEPS =
  '[\n  { "type": "reserve", "max_attempts": 3, "compensable": true, "compensator_task": "release" }\n]';

function DefinitionsPanel({ canRegister, hasKey }: { canRegister: boolean; hasKey: boolean }) {
  const defs = useDefinitions();
  const register = useRegisterDefinition();
  const toast = useToast();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1");
  const [stepsText, setStepsText] = useState(DEFAULT_STEPS);

  const stepsValid = useMemo(() => {
    try {
      const v: unknown = JSON.parse(stepsText);
      return Array.isArray(v) && v.length > 0 && v.every((s) => s && typeof s === "object" && "type" in s);
    } catch {
      return false;
    }
  }, [stepsText]);

  const canSubmit = canRegister && name.trim().length > 0 && Number(version) >= 1 && stepsValid && !register.isPending;

  return (
    <Panel title={<h2 className="text-sm font-semibold">Workflow definitions</h2>} kicker="GET/POST /v1/definitions" bodyClass="px-0 py-0">
      <Tabs defaultValue="registry" className="gap-0">
        <div className="border-b border-border/60 px-5 py-3">
          <TabsList variant="line" className="h-auto bg-transparent p-0">
            <TabsTrigger value="registry" className="text-xs">Registry</TabsTrigger>
            <TabsTrigger value="register" className="text-xs">Register a new version</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="registry" className="mt-0">
          {defs.isLoading && <div className="p-5"><LoadingRows rows={3} /></div>}
          {defs.isError && <div className="p-5"><ErrorState error={defs.error} /></div>}
          {defs.data && defs.data.length === 0 && (
            <div className="p-5">
              <EmptyState
                icon={<Database className="size-5" />}
                title="Registry is empty"
                hint="No definitions have been registered, so workflows cannot be created yet."
              />
            </div>
          )}
          {defs.data && defs.data.length > 0 && (
            /* min-width keeps every column readable; the shadcn table container
               scrolls horizontally instead of squeezing "Registered" away. */
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Version</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Steps</TableHead>
                  <TableHead scope="col">Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {defs.data.map((d) => (
                  <TableRow key={`${d.name}@${d.version}`}>
                    <TableCell className="font-medium text-foreground">{d.name}</TableCell>
                    <TableCell className="font-mono">v{d.version}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("gap-1.5", d.status === "ACTIVE" ? TONE.completed.badge : TONE.pending.badge)}>
                        <span className={cn("size-1.5 rounded-full", d.status === "ACTIVE" ? TONE.completed.dot : TONE.pending.dot)} aria-hidden="true" />
                        {d.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{d.steps.length} step{d.steps.length === 1 ? "" : "s"}</TableCell>
                    <TableCell className="text-muted-foreground"><TimeText iso={d.created_at} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="register" className="mt-0 space-y-4 p-5">
          {!hasKey && (
            <p className="flex items-start gap-2 rounded-lg border border-st-warn/40 bg-st-warn/5 px-3 py-2 text-xs text-st-warn">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>Present a key first — registration needs the <strong className="font-medium">admin</strong> role.</span>
            </p>
          )}
          {hasKey && !canRegister && (
            <p className="flex items-start gap-2 rounded-lg border border-st-warn/40 bg-st-warn/5 px-3 py-2 text-xs text-st-warn">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>This verb needs an <strong className="font-medium">admin</strong> key — the server answers 403 otherwise.</span>
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="definition-name">Name</Label>
              <Input id="definition-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="booking" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="definition-version">Version</Label>
              <Input id="definition-version" className="font-mono" type="number" min={1} value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="definition-steps">Steps document (JSON array)</Label>
            <Textarea
              id="definition-steps"
              className="font-mono text-xs"
              rows={6}
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
              spellCheck={false}
              aria-invalid={!stepsValid}
              aria-describedby={stepsValid ? "definition-steps-hint" : "definition-steps-error"}
            />
            {!stepsValid && (
              <span id="definition-steps-error" role="alert" className="block text-xs text-st-negative">
                Must be a non-empty JSON array of objects, each with a “type”.
              </span>
            )}
            <span id="definition-steps-hint" className="block text-xs text-muted-foreground">
              Fields per step: type · max_attempts · compensable · compensator_task · forward_timeout_secs.
              Definitions are immutable — re-registering an existing name+version answers 409.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canSubmit}
              onClick={() =>
                register.mutate(
                  { name: name.trim(), version: Number(version), steps: JSON.parse(stepsText) },
                  {
                    onSuccess: (d) => { toast({ tone: "ok", text: `Registered ${d.name}@v${d.version}` }); setName(""); },
                    onError: () => undefined,
                  },
                )
              }
            >
              <Check data-slot="icon" /> {register.isPending ? "Registering…" : "Register definition"}
            </Button>
            {!canRegister && <span className="text-xs text-muted-foreground">Disabled: an admin key is required.</span>}
          </div>

          {register.isError && <ErrorState error={register.error} />}
          {register.data && (
            <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <span>Last registered: <strong className="font-medium text-foreground">{register.data.name}@v{register.data.version}</strong></span>
              <JsonView value={register.data.steps} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Panel>
  );
}
