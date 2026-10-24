import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
// legacy fx-* design system — imported only until the migration completes (Phase 7 §7)
import "./theme/tokens.css";
import "./theme/base.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
