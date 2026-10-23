/* API provider: one client, one Endpoints surface, one react-query cache.
   Retry policy is rate-limit aware (429 honours Retry-After) and never
   hammers 4xx failures. Server state lives ONLY in this query cache —
   no second copy of engine state in client stores (UI spec §5). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { FathomClient } from "../api/client";
import { Endpoints } from "../api/endpoints";
import { RateLimitError } from "../api/errors";
import { useSettings } from "./settings";

const ApiCtx = createContext<Endpoints | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();

  const endpoints = useMemo(() => {
    // Rebuilt when the key changes; the getter reads the current token so a
    // long-lived query never caches a stale credential.
    const client = new FathomClient({ getKey: () => settings.key?.token ?? null });
    return new Endpoints(client);
  }, [settings.key?.token]);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1_500,
            refetchOnWindowFocus: false,
            retry: (failureCount, err) => {
              if (err instanceof RateLimitError) return failureCount < 2;
              if (err instanceof Error && (err.name === "ApiError" || err.name === "AuthError")) return false;
              if (err.name === "AbortError") return false;
              return failureCount < 1; // connection blip: one retry, then show disconnected state
            },
            retryDelay: (attempt, err) =>
              err instanceof RateLimitError ? err.retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 4000),
          },
          mutations: { retry: 0 },
        },
      }),
    [],
  );

  return (
    <ApiCtx.Provider value={endpoints}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiCtx.Provider>
  );
}

export function useApi(): Endpoints {
  const v = useContext(ApiCtx);
  if (!v) throw new Error("useApi outside ApiProvider");
  return v;
}
