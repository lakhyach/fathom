import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "../components/ui";

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
