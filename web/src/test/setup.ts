/* Vitest global setup: jest-dom matchers + the minimal browser APIs jsdom lacks
   that the cockpit relies on (clipboard, crypto.randomUUID, ResizeObserver used
   by React Flow, and matchMedia for the reduced-motion path). */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (!("ResizeObserver" in window)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ResizeObserver = RO;
  }

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  }

  if (!crypto.randomUUID) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).randomUUID = () =>
      "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  if (!Element.prototype.scrollIntoView) {
    // jsdom lacks it; cmdk scrolls the active option on mount. No-op is enough.
    Element.prototype.scrollIntoView = () => {};
  }
}
