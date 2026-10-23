import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
  plugins: [react()] as any,
  server: {
    proxy: {
      "/v1": { target: BACKEND, changeOrigin: false },
      "/healthz": { target: BACKEND, changeOrigin: false },
      "/readyz": { target: BACKEND, changeOrigin: false },
      "/metrics": { target: BACKEND, changeOrigin: false },
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
