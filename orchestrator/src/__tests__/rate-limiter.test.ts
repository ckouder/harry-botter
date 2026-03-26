import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "../rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5 * 60 * 1000); // 5 min window
  });

  it("allows first request", () => {
    const result = limiter.check("U12345");
    expect(result.allowed).toBe(true);
  });

  it("blocks rapid second request", () => {
    limiter.record("U12345");
    const result = limiter.check("U12345");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows different users independently", () => {
    limiter.record("U1");
    const result = limiter.check("U2");
    expect(result.allowed).toBe(true);
  });

  it("allows after window expires", () => {
    // Use a tiny window
    const fastLimiter = new RateLimiter(10); // 10ms
    fastLimiter.record("U1");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = fastLimiter.check("U1");
        expect(result.allowed).toBe(true);
        resolve();
      }, 20);
    });
  });
});
