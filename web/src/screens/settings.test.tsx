import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { ToastProvider } from "../components/ui";
import { SettingsProvider } from "../state/settings";

/* Settings talks to five endpoints. Mocking the hooks module keeps the test
   about the screen's contract: honest probe states, key-spec validation, and
   the admin-only registration gate. */
vi.mock("../api/hooks", () => ({
  useHealthz: () => ({ isLoading: false, isError: false, data: { status: "ok" }, refetch: vi.fn() }),
  useReadyz: () => ({
    isLoading: false,
    isError: false,
    // A VALID 503 body — degraded, not unreachable.
    data: { status: "unavailable", reason: "relay_lag" },
    refetch: vi.fn(),
  }),
  useMetrics: () => ({ isLoading: false, isError: false, data: { fathom_dlq_depth: { samples: [] } }, refetch: vi.fn() }),
  useDefinitions: () => ({
    isLoading: false,
    isError: false,
    data: [{ name: "echo-single", version: 1, status: "ACTIVE", steps: [{ type: "echo" }], created_at: "2026-10-23T00:00:00Z" }],
  }),
  useRegisterDefinition: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, data: undefined }),
}));

function renderSettings(keySpec = "ad:admin:dev-admin-key") {
  window.localStorage.clear();
  window.localStorage.setItem("fathom.cockpit.settings.v1", JSON.stringify({ keySpec, timeFormat: "utc" }));
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <ToastProvider>
          <Settings />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

describe("Settings — connection probes", () => {
  it("reports a degraded /readyz as a warning, never as healthy", () => {
    renderSettings();
    const row = screen.getByText("Readiness").closest("div");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("readyz: unavailable · relay_lag");
    expect(row?.querySelector('[class*="text-st-warn"]')).not.toBeNull();
    expect(row?.querySelector('[class*="text-st-completed"]')).toBeNull();
  });

  it("keeps liveness healthy and counts the metric families", () => {
    renderSettings();
    expect(screen.getByText("Liveness").closest("div")).toHaveTextContent("ok");
    expect(screen.getByText("Metrics").closest("div")).toHaveTextContent("1 families");
  });
});

describe("Settings — API key", () => {
  it("rejects a malformed spec: inline error, disabled apply, nothing persisted", async () => {
    renderSettings("");
    const input = screen.getByLabelText("Key spec");
    await userEvent.clear(input);
    await userEvent.type(input, "bad");
    expect(input).toBeInvalid();
    expect(await screen.findByRole("alert")).toHaveTextContent("Does not parse as a valid key spec.");
    expect(screen.getByRole("button", { name: /Apply key/ })).toBeDisabled();
    expect(JSON.parse(window.localStorage.getItem("fathom.cockpit.settings.v1") ?? "{}").keySpec).toBe("");
  });

  it("previews the parsed identity before it is applied", async () => {
    renderSettings("");
    await userEvent.type(screen.getByLabelText("Key spec"), "ops:operator:deadbeefcafe");
    await waitFor(() => expect(screen.getByText(/will present as/i)).toBeInTheDocument());
    expect(screen.getByText("ops · role operator", { exact: false })).toHaveTextContent("role operator");
  });

  it("clears the session and toasts it", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("button", { name: /Clear/ }));
    expect(await screen.findByText("no key presented — /v1 reads will 401.", { exact: false })).toBeInTheDocument();
    expect(await screen.findByText("Key cleared")).toBeInTheDocument();
  });
});

describe("Settings — definitions registration gate", () => {
  it("lists the live registry", () => {
    renderSettings();
    expect(screen.getByRole("tab", { name: /Registry/ })).toBeInTheDocument();
    expect(screen.getAllByText("echo-single").length).toBeGreaterThan(0);
  });

  it("refuses to offer the admin verb to a reader key", async () => {
    renderSettings("ro:reader:readerkey123");
    await userEvent.click(screen.getByRole("tab", { name: /Register a new version/ }));
    expect(await screen.findByText(/the server answers 403 otherwise/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Register definition/ })).toBeDisabled();
  });

  it("enables the admin verb for an admin key with a valid steps document", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("tab", { name: /Register a new version/ }));
    expect(screen.queryByText(/the server answers 403 otherwise/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Register definition/ })).toBeDisabled(); // name still empty
    await userEvent.type(screen.getByLabelText("Name"), "qa-def");
    expect(await screen.findByRole("button", { name: /Register definition/ })).toBeEnabled();
  });

  it("flags a steps document that is not a JSON array of typed objects", async () => {
    renderSettings();
    await userEvent.click(screen.getByRole("tab", { name: /Register a new version/ }));
    const steps = screen.getByLabelText("Steps document (JSON array)");
    await userEvent.clear(steps);
    await userEvent.type(steps, "[1]");
    expect(steps).toBeInvalid();
    expect(await screen.findByRole("alert")).toHaveTextContent("Must be a non-empty JSON array");
  });
});
