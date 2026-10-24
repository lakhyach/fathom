import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dlq } from "./Dlq";
import { ToastProvider } from "../components/ui";
import { SettingsProvider } from "../state/settings";
import type { DeadLetter } from "../api/types";

/* The live dead-letter queue was empty during the Phase 7 browser sweep, so the
   two W17 exits could not be clicked in a real tab. These tests carry that
   coverage instead: dry-run-before-write, the mandatory-reason gate, the
   reader-role refusal, and the open/all request switch. */
const h = vi.hoisted(() => ({
  items: [] as DeadLetter[],
  listParams: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));

vi.mock("../api/hooks", () => ({
  useDlq: (params: Record<string, unknown>) => {
    h.listParams = params;
    return {
      isLoading: false,
      isError: false,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
      data: { items: h.items, next_cursor: null },
    };
  },
  useMetrics: () => ({
    isLoading: false,
    isError: false,
    data: { fathom_dlq_depth: { samples: [] } },
    refetch: vi.fn(),
  }),
  useResolveDlq: () => ({ mutate: h.mutate, isPending: false, error: null }),
}));

const openItem: DeadLetter = {
  id: "dlq-1",
  workflow_id: "01a169e6-43f3-7d7f-97a0-df4d977e4bfc",
  step_type: "reserve",
  attempt: 3,
  class: "UNMATCHED_EVENT",
  reason_code: "UNMATCHED_EVENT",
  detail: { event_id: "evt-9" },
  created_at: "2026-10-23T10:00:00Z",
  resolved_at: null,
  resolved_by: null,
  resolution: null,
};

function renderDlq(items: DeadLetter[], keySpec = "ops:operator:deadbeefcafe") {
  h.items = items;
  window.localStorage.clear();
  window.localStorage.setItem(
    "fathom.cockpit.settings.v1",
    JSON.stringify({ keySpec, timeFormat: "utc" }),
  );
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <ToastProvider>
          <Dlq />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

describe("Dead letter queue", () => {
  beforeEach(() => {
    h.items = [];
    h.mutate.mockReset();
  });

  it("presents an empty queue as the healthy state, not as a failure", () => {
    renderDlq([]);
    expect(screen.getByText("No open dead letters")).toBeInTheDocument();
    expect(
      screen.getByText(/empty queue is the healthy state/i),
    ).toBeInTheDocument();
  });

  it("previews with a real server-side dry run before any write", async () => {
    renderDlq([openItem]);
    await userEvent.click(
      screen.getAllByRole("button", { name: /^Preview$/ })[0],
    );
    expect(h.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dlq-1",
        action: "force-terminate",
        dry_run: true,
      }),
      expect.anything(),
    );
    expect(
      h.mutate.mock.calls.every(
        (c) => (c[0] as { dry_run: boolean }).dry_run === true,
      ),
    ).toBe(true);
  });

  it("refuses to fire the confirmed write until a reason exists", async () => {
    renderDlq([openItem]);
    await userEvent.click(screen.getByRole("button", { name: "Terminate" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/without running compensation/i);
    expect(
      screen.getByText(/POST \/v1\/dlq\/dlq-1\/actions:resolve/i),
    ).toBeInTheDocument();

    /* The row action and the dialog confirm share the "Terminate" label, so the
       confirm is looked up inside the dialog. */
    const confirm = within(dialog).getByRole("button", { name: "Terminate" });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText(/Reason \(required/i),
      "vendor confirmed the order was never placed",
    );
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    expect(h.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        dry_run: false,
        reason: "vendor confirmed the order was never placed",
      }),
      expect.anything(),
    );
  });

  it("keeps the verbs visible but inert for a reader key, and says why", () => {
    renderDlq([openItem], "ro:reader:readerkey123");
    expect(screen.getByText(/the server answers 403/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compensate" })).toBeDisabled();
  });

  it("switches the list request when the resolution filter changes", async () => {
    renderDlq([openItem]);
    expect(h.listParams).toMatchObject({ open: true });
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(h.listParams).toMatchObject({ open: false }));
  });
});
