import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { MotionConfig } from "motion/react";

import { ApiProvider } from "./state/api";
import { SettingsProvider } from "./state/settings";
import { ToastProvider } from "./components/ui";
import { Shell } from "./shell/Shell";

const Overview = lazy(() =>
  import("./screens/Overview").then((m) => ({ default: m.Overview })),
);
const Workflows = lazy(() =>
  import("./screens/Workflows").then((m) => ({ default: m.Workflows })),
);
const WorkflowDetail = lazy(() =>
  import("./screens/WorkflowDetail").then((m) => ({ default: m.WorkflowDetail })),
);
const Dlq = lazy(() =>
  import("./screens/Dlq").then((m) => ({ default: m.Dlq })),
);
const Events = lazy(() =>
  import("./screens/Events").then((m) => ({ default: m.Events })),
);
const Metrics = lazy(() =>
  import("./screens/Metrics").then((m) => ({ default: m.Metrics })),
);
const Settings = lazy(() =>
  import("./screens/Settings").then((m) => ({ default: m.Settings })),
);
const NotFound = lazy(() =>
  import("./screens/NotFound").then((m) => ({ default: m.NotFound })),
);

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <SettingsProvider>
        <ApiProvider>
          <ToastProvider>
            <BrowserRouter>
              <Suspense
                fallback={
                  <div
                    role="status"
                    className="grid min-h-screen place-items-center text-sm text-muted-foreground"
                  >
                    Loading cockpit…
                  </div>
                }
              >
                <Routes>
                  <Route element={<Shell />}>
                    <Route index element={<Overview />} />
                    <Route path="workflows" element={<Workflows />} />
                    <Route path="workflows/:id" element={<WorkflowDetail />} />
                    <Route path="dlq" element={<Dlq />} />
                    <Route path="events" element={<Events />} />
                    <Route path="metrics" element={<Metrics />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </ToastProvider>
        </ApiProvider>
      </SettingsProvider>
    </MotionConfig>
  );
}
