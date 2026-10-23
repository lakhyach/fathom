/* Settings & connection diagnostics. The operator presents their API key here
   (never baked into source); the key spec is validated with the SAME parser the
   backend uses so the displayed role hint matches enforcement. Connection
   diagnostics run the three real unauthenticated probes. The definitions panel
   lists the live registry and — for admin keys only — registers a new version,
   mirroring POST /v1/definitions exactly (name, version>=1, steps document). */
import { useMemo, useState } from "react";

import { useDefinitions, useHealthz, useMetrics, useReadyz, useRegisterDefinition } from "../api/hooks";
import type { Readyz } from "../api/types";
import { parseKeySpec, useSettings, type TimeFormat } from "../state/settings";
import {
  EmptyState,
  ErrorState,
  JsonView,
  LoadingRows,
  Panel,
  TimeText,
  useToast,
} from "../components/ui";
import { IconCheck, IconDatabase, IconKey, IconPlug, IconX } from "../icons";
import "./screens.css";

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
    <div className="fx-screen">
      <div className="fx-page-head">
        <div>
          <span className="kicker">Configuration</span>
          <h1>Settings</h1>
          <p className="fx-page-sub">
            The cockpit is stateless: it stores only this browser’s key and display preference, and reads
            every fact from the live control plane. Roles are enforced server-side — a reader key cannot
            write, no matter what this UI shows.
          </p>
        </div>
      </div>

      <div className="fx-settings-grid">
        <Panel title={<h2>API key</h2>} kicker="Authorization: Bearer …" className="">
          <div className="fx-keyform">
            <div className="field">
              <label htmlFor="fx-keyspec">Key spec</label>
              <input
                id="fx-keyspec"
                className="input mono"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="label:role:key   —   e.g. ops:operator:deadbeef…"
                spellCheck={false}
                aria-invalid={draftInvalid}
                autoComplete="off"
              />
              <span className="hint">
                Accepted shapes: <code className="mono">label:role:key</code> (role = reader | operator | admin) or a
                bare key of 8+ chars. Stored only in <code className="mono">localStorage</code> for this browser.
              </span>
              {draftInvalid && <span className="err">Does not parse as a valid key spec.</span>}
              {parsed && (
                <span className="fx-kv">
                  <span>will present as</span>
                  <span>
                    <strong>{parsed.label}</strong> · role {parsed.role ?? "unknown"} · {parsed.token.slice(0, 4)}…
                    {parsed.token.length > 4 ? parsed.token.slice(-2) : ""}
                  </span>
                </span>
              )}
            </div>
            <div className="fx-keyform__row">
              <button type="button" className="btn btn-primary btn-sm" disabled={draftInvalid} onClick={saveKey}>
                <IconKey size={13} /> Apply key
              </button>
              {settings.keySpec && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { settings.clearKey(); setDraft(""); toast({ tone: "warn", text: "Key cleared" }); }}
                >
                  <IconX size={13} /> Clear
                </button>
              )}
            </div>
            <p className="fx-note">
              Current session: {settings.key ? <><strong>{settings.key.label}</strong> · role {settings.key.role ?? "unknown"}</> : "no key presented — /v1 reads will 401."}
            </p>
          </div>
        </Panel>

        <Panel title={<h2>Connection</h2>} kicker="live probes (unauthenticated)" className="">
          <ConnectionDiagnostics />
          <div className="field" style={{ marginTop: "var(--fx-sp-4)" }}>
            <span className="kicker">Time format</span>
            <div className="fx-keyform__row">
              {(["utc", "local"] as TimeFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`fx-chip ${settings.timeFormat === f ? "fx-chip--on" : ""}`}
                  onClick={() => settings.setTimeFormat(f)}
                >
                  {f === "utc" ? "UTC (24 h)" : "Browser local"}
                </button>
              ))}
            </div>
            <span className="hint">Applies to every timestamp in the cockpit. Now: <TimeText iso={new Date().toISOString()} /></span>
          </div>
        </Panel>
      </div>

      <DefinitionsPanel canRegister={settings.key?.role === "admin"} hasKey={!!settings.key} />
    </div>
  );
}

function ConnectionDiagnostics() {
  const healthz = useHealthz();
  const readyz = useReadyz();
  const metrics = useMetrics();

  type Probe = { isLoading: boolean; isError: boolean; data?: unknown; refetch: () => unknown };
  const row = (label: string, path: string, q: Probe) => {
    // A transport error is red; but /readyz answers a VALID 503 body when the
    // engine is degraded (relay lag), so readiness reflects the parsed status,
    // not mere reachability — a green dot would contradict the copy.
    const readyz = label === "Readiness" ? (q.data as Readyz | undefined) : undefined;
    const state = q.isLoading ? "wait" : q.isError ? "bad" : readyz?.status === "unavailable" ? "warn" : "ok";
    let detail = "ok";
    if (q.isLoading) detail = "probing…";
    else if (q.isError) detail = "unreachable";
    else if (readyz) detail = readyz.reason ? `readyz: ${readyz.status} · ${readyz.reason}` : `readyz: ${readyz.status}`;
    else if (label === "Metrics") detail = `${Object.keys((q.data as Record<string, unknown>) ?? {}).length} families`;
    return (
      <div className="fx-probe-row">
        <span className={`fx-probe fx-probe--${state}`}>
          <span className="fx-probe__dot" aria-hidden="true" />
          <strong>{label}</strong>
        </span>
        <code className="mono fx-dim">{path}</code>
        <span className="fx-probe__detail">{detail}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => q.refetch()}>Re-probe</button>
      </div>
    );
  };

  return (
    <div className="fx-probes">
      {row("Liveness", "GET /healthz", healthz)}
      {row("Readiness", "GET /readyz", readyz)}
      {row("Metrics", "GET /metrics", metrics)}
      <p className="fx-note">
        <IconPlug size={12} /> Requests are same-origin and reach the API through the dev proxy
        (<code className="mono">FATHOM_API_TARGET</code>). No CORS origin is configured server-side, so the
        cockpit must be served from the proxy, not a separate host.
      </p>
    </div>
  );
}

function DefinitionsPanel({ canRegister, hasKey }: { canRegister: boolean; hasKey: boolean }) {
  const defs = useDefinitions();
  const register = useRegisterDefinition();
  const toast = useToast();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1");
  const [stepsText, setStepsText] = useState('[\n  { "type": "reserve", "max_attempts": 3, "compensable": true, "compensator_task": "release" }\n]');

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
    <Panel title={<h2>Workflow definitions</h2>} kicker="GET/POST /v1/definitions" bodyClass="fx-panel__body--flush">
      {defs.isLoading && <div style={{ padding: 16 }}><LoadingRows rows={3} /></div>}
      {defs.isError && <div style={{ padding: 16 }}><ErrorState error={defs.error} /></div>}
      {defs.data && defs.data.length === 0 && (
        <div style={{ padding: 16 }}>
          <EmptyState icon={<IconDatabase size={20} />} title="Registry is empty" hint="No definitions have been registered, so workflows cannot be created yet." />
        </div>
      )}
      {defs.data && defs.data.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Steps</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {defs.data.map((d) => (
              <tr key={`${d.name}@${d.version}`}>
                <td><span className="fx-wfstate">{d.name}</span></td>
                <td className="mono">v{d.version}</td>
                <td>
                  <span className={`fx-badge fx-badge--sm ${d.status === "ACTIVE" ? "fx-badge--completed" : "fx-badge--pending"}`}>
                    <span className="fx-badge__label">{d.status}</span>
                  </span>
                </td>
                <td>{d.steps.length} step{d.steps.length === 1 ? "" : "s"}</td>
                <td><TimeText iso={d.created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="fx-register">
        <div className="fx-register__head">
          <span className="kicker">Register a new version</span>
          {!hasKey && <span className="fx-note fx-note--warn inline">Present a key first.</span>}
          {hasKey && !canRegister && <span className="fx-note fx-note--warn inline">This verb needs an <strong>admin</strong> key — the server answers 403 otherwise.</span>}
        </div>
        <div className="fx-form-grid">
          <div className="field">
            <label htmlFor="fx-def-name">Name</label>
            <input id="fx-def-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="booking" />
          </div>
          <div className="field">
            <label htmlFor="fx-def-ver">Version</label>
            <input id="fx-def-ver" className="input" type="number" min={1} value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="fx-def-steps">Steps document (JSON array)</label>
          <textarea id="fx-def-steps" className="input mono" rows={6} value={stepsText} onChange={(e) => setStepsText(e.target.value)} spellCheck={false} aria-invalid={!stepsValid} />
          {!stepsValid && <span className="err">Must be a non-empty JSON array of objects, each with a “type”.</span>}
          <span className="hint">Fields per step: type · max_attempts · compensable · compensator_task · forward_timeout_secs. Definitions are immutable — re-registering an existing name+version answers 409.</span>
        </div>
        <div className="fx-keyform__row">
          <button
            type="button"
            className="btn btn-primary btn-sm"
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
            <IconCheck size={13} /> {register.isPending ? "Registering…" : "Register definition"}
          </button>
        </div>
        {register.isError && <ErrorState error={register.error} />}
        {register.data && (
          <div className="fx-receipt">Last registered: {register.data.name}@v{register.data.version} · <JsonView value={register.data.steps} /></div>
        )}
      </div>
    </Panel>
  );
}
