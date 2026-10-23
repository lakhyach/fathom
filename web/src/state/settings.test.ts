import { describe, expect, it } from "vitest";

import { parseKeySpec } from "./settings";

describe("parseKeySpec (mirrors the server’s ParseKeys)", () => {
  it("parses label:role:key and keeps the role", () => {
    const k = parseKeySpec("ops:operator:abc12345");
    expect(k).toEqual({ label: "ops", role: "operator", token: "abc12345" });
  });

  it("accepts a bare token of 8+ chars with role unknown", () => {
    const k = parseKeySpec("deadbeefcafe");
    expect(k).not.toBeNull();
    expect(k?.role).toBeNull();
    expect(k?.token).toBe("deadbeefcafe");
  });

  it("still accepts a 3-part spec with an unknown role, but marks role unknown (server stays authoritative)", () => {
    // label + token present but role "superuser" is not one of the three → role null
    const k = parseKeySpec("x:superuser:y");
    expect(k).toEqual({ label: "x", role: null, token: "y" });
  });

  it("rejects empty, whitespace and too-short bare tokens", () => {
    expect(parseKeySpec("")).toBeNull();
    expect(parseKeySpec("   ")).toBeNull();
    expect(parseKeySpec("short")).toBeNull(); // < 8 chars
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseKeySpec("  r:reader:token9  ")?.role).toBe("reader");
  });
});
