/* Cockpit settings: the bearer key + display preferences, persisted to this
   browser's localStorage only. Nothing sensitive ships in source code
   (brief §6): the key is entered by the operator at runtime. This is the
   documented local-dev boundary — the API itself refuses non-loopback binds
   (api.LoopbackOnly), and cockpit session/CSRF auth is a later backend phase
   (ADR-013), so the browser-held key is the honest current model. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Role = "reader" | "operator" | "admin";
export type TimeFormat = "utc" | "local";

export interface KeyInfo {
  label: string;
  role: Role | null; // null → raw key pasted without a role hint
  token: string;
}

interface Persisted {
  /** the operator's key spec: "label:role:key" or a bare key */
  keySpec: string;
  timeFormat: TimeFormat;
}

const STORAGE_KEY = "fathom.cockpit.settings.v1";

const DEFAULTS: Persisted = { keySpec: "", timeFormat: "utc" };

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      keySpec: typeof p.keySpec === "string" ? p.keySpec : "",
      timeFormat: p.timeFormat === "local" ? "local" : "utc",
    };
  } catch {
    return DEFAULTS;
  }
}

/** Parse "label:role:key" exactly like the server's ParseKeys — so the
 *  displayed role hint matches what the backend will enforce. A bare token
 *  (no colons) is accepted with role unknown. Server stays authoritative. */
export function parseKeySpec(spec: string): KeyInfo | null {
  const s = spec.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length === 3) {
    const [label, role, token] = parts;
    const valid = role === "reader" || role === "operator" || role === "admin";
    if (label && token)
      return { label, role: valid ? (role as Role) : null, token };
    return null;
  }
  if (parts.length === 1 && s.length >= 8)
    return { label: "key", role: null, token: s };
  return null;
}

interface SettingsValue extends Persisted {
  key: KeyInfo | null;
  setKeySpec: (spec: string) => boolean; // false when the spec is malformed
  clearKey: () => void;
  setTimeFormat: (f: TimeFormat) => void;
}

const Ctx = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private mode / quota: settings stay in-memory, which is fine */
    }
  }, [state]);

  const setKeySpec = useCallback((spec: string) => {
    if (spec.trim() && !parseKeySpec(spec)) return false;
    setState((s) => ({ ...s, keySpec: spec }));
    return true;
  }, []);

  const clearKey = useCallback(
    () => setState((s) => ({ ...s, keySpec: "" })),
    [],
  );
  const setTimeFormat = useCallback(
    (f: TimeFormat) => setState((s) => ({ ...s, timeFormat: f })),
    [],
  );

  const value = useMemo<SettingsValue>(
    () => ({
      ...state,
      key: parseKeySpec(state.keySpec),
      setKeySpec,
      clearKey,
      setTimeFormat,
    }),
    [state, setKeySpec, clearKey, setTimeFormat],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings outside SettingsProvider");
  return v;
}
