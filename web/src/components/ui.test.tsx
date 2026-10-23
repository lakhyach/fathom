import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "../components/ui";

describe("StatusBadge", () => {
  it("renders the human label and a tone class — colour plus text, never colour alone", () => {
    render(<StatusBadge state="COMPENSATING" />);
    expect(screen.getByText("Compensating")).toBeInTheDocument();
    expect(document.querySelector(".fx-badge--compensating")).not.toBeNull();
  });

  it("shows an accessible alert marker on FAILED_MANUAL", () => {
    const { container } = render(<StatusBadge state="FAILED_MANUAL" />);
    expect(container.querySelector(".fx-badge--manual")).not.toBeNull();
    expect(screen.getByText("Failed · manual")).toBeInTheDocument();
  });

  it("uses the step vocabulary for kind=step", () => {
    render(<StatusBadge state="IN_PROGRESS" kind="step" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });
});
