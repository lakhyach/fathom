import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge, ErrorState } from "../components/ui";
import { AuthError, ConnectionError } from "../api/errors";

describe("StatusBadge", () => {
  it("renders the human label and a tone class — colour plus text, never colour alone", () => {
    render(<StatusBadge state="COMPENSATING" />);
    expect(screen.getByText("Compensating")).toBeInTheDocument();
    const badge = document.querySelector('[data-slot="badge"][data-tone="compensating"]');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain("text-st-compensating");
  });

  it("shows an accessible alert marker on FAILED_MANUAL", () => {
    const { container } = render(<StatusBadge state="FAILED_MANUAL" />);
    expect(container.querySelector('[data-tone="manual"]')).not.toBeNull();
    expect(container.querySelector('[data-tone="manual"] svg')).not.toBeNull();
    expect(screen.getByText("Failed · manual")).toBeInTheDocument();
  });

  it("uses the step vocabulary for kind=step", () => {
    render(<StatusBadge state="IN_PROGRESS" kind="step" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });
});

/* The shared failure states are the cockpit's honesty layer: a 401, a 403 and a
   dead transport must never render as the same sentence. */
describe("ErrorState", () => {
  it("tells an unauthenticated operator to present a key", () => {
    render(<ErrorState error={new AuthError("unauthenticated")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Authentication required");
    expect(screen.getByText("Open Settings and present an API key.")).toBeInTheDocument();
  });

  it("names the role gap instead of the key when the server answered 403", () => {
    render(<ErrorState error={new AuthError("forbidden")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not permitted for this key");
    expect(screen.getByText(/role on your presented key does not allow this verb/)).toBeInTheDocument();
  });

  it("renders a transport failure as degraded, not as an API error", () => {
    render(<ErrorState error={new ConnectionError("Failed to fetch")} />);
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("Disconnected");
    expect(box.className).toContain("border-st-warn/40");
  });
});
