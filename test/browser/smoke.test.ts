import { describe, it, expect } from "vitest";

describe("browser runner smoke", () => {
  it("runs in a real browser context (window defined)", () => {
    expect(typeof window).toBe("object");
  });
});
