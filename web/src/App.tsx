import { BrowserRouter, Route, Routes } from "react-router";
import { MotionConfig } from "motion/react";

import { ApiProvider } from "./state/api";
import { SettingsProvider } from "./state/settings";
import { ToastProvider } from "./components/ui";
import { Shell } from "./shell/Shell";
import { Overview } from "./screens/Overview";
import { Workflows } from "./screens/Workflows";
import { WorkflowDetail } from "./screens/WorkflowDetail";
import { Dlq } from "./screens/Dlq";
import { Events } from "./screens/Events";
import { Metrics } from "./screens/Metrics";
import { Settings } from "./screens/Settings";
import { NotFound } from "./screens/NotFound";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <SettingsProvider>
        <ApiProvider>
          <ToastProvider>
            <BrowserRouter>
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
            </BrowserRouter>
          </ToastProvider>
        </ApiProvider>
      </SettingsProvider>
    </MotionConfig>
  );
}
