import { describe, it, expect } from "vitest";
import { UserLock } from "../user-lock";

describe("UserLock", () => {
  it("acquires and releases lock", async () => {
    const lock = new UserLock();
    const release = await lock.acquire("U1");
    expect(typeof release).toBe("function");
    release();
  });

  it("serializes concurrent operations for same user", async () => {
    const lock = new UserLock();
    const order: number[] = [];

    const op1 = lock.acquire("U1").then((release) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push(1);
          release();
          resolve();
        }, 50);
      });
    });

    const op2 = lock.acquire("U1").then((release) => {
      order.push(2);
      release();
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]);
  });

  it("allows concurrent operations for different users", async () => {
    const lock = new UserLock();
    const results: string[] = [];

    const op1 = lock.acquire("U1").then((release) => {
      results.push("U1");
      release();
    });

    const op2 = lock.acquire("U2").then((release) => {
      results.push("U2");
      release();
    });

    await Promise.all([op1, op2]);
    expect(results).toContain("U1");
    expect(results).toContain("U2");
  });
});
