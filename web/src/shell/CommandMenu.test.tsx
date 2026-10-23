import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { CommandMenu } from "./CommandMenu";

// The palette's only external dependency is the live recent-workflows query.
// Mock the whole api/hooks module for this file so the test never touches the
// network; the two fixtures below mirror the real /v1/workflows summary shape.
vi.mock("../api/hooks", () => ({
  useWorkflows: () => ({
    data: {
      items: [
        {
          id: "01a169e6-43a3-76a4-97f6-6cf52545b3db",
          def_name: "echo-single",
          def_version: 1,
          state: "COMPLETED",
          version: 2,
          business_key: "demo-happy-1",
          deadline_at: "2026-10-24T00:00:00Z",
          created_at: "2026-10-23T00:00:00Z",
          updated_at: new Date().toISOString(),
          finished_at: "2026-10-23T00:00:01Z",
        },
        {
          id: "01a169e6-43f3-7d7f-97a0-df4d977e4bfc",
          def_name: "echo-compensate",
          def_version: 1,
          state: "ABORTED",
          version: 3,
          business_key: "demo-comp-1",
          deadline_at: "2026-10-24T00:00:00Z",
          created_at: "2026-10-23T00:00:00Z",
          updated_at: new Date().toISOString(),
          finished_at: "2026-10-23T00:00:02Z",
        },
      ],
      next_cursor: null,
    },
  }),
}));

function PathProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

describe("CommandMenu", () => {
  it("renders real routes + the mocked live recent-workflow fixtures", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<PathProbe />} />
        </Routes>
        <CommandMenu open onClose={vi.fn()} onNewWorkflow={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("option", { name: /Dead Letter/i })).toBeInTheDocument();
    // fixtures come from the (mocked) real list query, not hard-coded markup
    expect(screen.getByRole("option", { name: /echo-single/i })).toBeInTheDocument();
  });

  it("closes and navigates to a route when a Navigate item is chosen", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={["/metrics"]}>
        <Routes>
          <Route path="*" element={<PathProbe />} />
        </Routes>
        <CommandMenu open onClose={onClose} onNewWorkflow={vi.fn()} />
      </MemoryRouter>,
    );
    const overview = await screen.findByRole("option", { name: /Overview/i });
    await userEvent.click(overview);
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId("path")).toHaveTextContent("/");
  });

  it("navigates to the real workflow detail route from a recent item", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<PathProbe />} />
        </Routes>
        <CommandMenu open onClose={vi.fn()} onNewWorkflow={vi.fn()} />
      </MemoryRouter>,
    );
    const item = await screen.findByRole("option", { name: /echo-compensate/i });
    await userEvent.click(item);
    expect(screen.getByTestId("path")).toHaveTextContent("/workflows/01a169e6-43f3-7d7f-97a0-df4d977e4bfc");
  });

  it("invokes the real New-workflow action without navigating", async () => {
    const onNewWorkflow = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<PathProbe />} />
        </Routes>
        <CommandMenu open onClose={onClose} onNewWorkflow={onNewWorkflow} />
      </MemoryRouter>,
    );
    const action = await screen.findByRole("option", { name: /New workflow/i });
    await userEvent.click(action);
    expect(onNewWorkflow).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId("path")).toHaveTextContent("/");
  });
});
