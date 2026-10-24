import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The cockpit talks to the control plane exclusively through this dev proxy:
// the API serves loopback-only with bearer-key auth (api.LoopbackOnly, Phase 5)
// and sends no CORS headers, so a direct cross-origin fetch from the browser
// would fail by design. Proxying keeps the backend contract untouched.
const BACKEND = process.env.FATHOM_API_TARGET || "http://127.0.0.1:8080";

export default defineConfig({
  // vitest bundles its own vite copy; the react plugin is typed against the
  // app's vite 8, so the arrays differ structurally. The runtime contract is
  // identical — cast across the two vite type universes at this single seam.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react(), tailwindcss()] as any,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/v1": { target: BACKEND, changeOrigin: false },
      "/healthz": { target: BACKEND, changeOrigin: false },
      "/readyz": { target: BACKEND, changeOrigin: false },
      "/metrics": {
        target: BACKEND,
        changeOrigin: false,
        // The SPA route "/metrics" (Metrics & Health screen) collides with the
        // backend's Prometheus scrape path. A top-level browser navigation or
        // refresh sends Accept: text/html — serve the app shell so the screen
        // renders; the cockpit's own data fetch sends Accept: */* and is proxied
        // to the backend exactly as before. Without this, deep-linking or
        // refreshing /metrics returned raw exposition text instead of the app.
        bypass(req) {
          if (req.headers.accept?.includes("text/html")) return "/index.html";
          return null;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
  build: {
    sourcemap: true,
    target: "es2022",
  },
});
