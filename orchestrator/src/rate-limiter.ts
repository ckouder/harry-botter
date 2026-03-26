/**
 * In-memory rate limiter for pod creation.
 *
 * Max 1 pod creation per user per WINDOW_MS (default 5 min).
 * Sliding window via Map<userId, lastCreateTimestamp>.
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export class RateLimiter {
  private lastCreate = new Map<string, number>();
  private windowMs: number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Check if a user is allowed to create a pod.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  check(userId: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const last = this.lastCreate.get(userId);
    if (!last) return { allowed: true };

    const elapsed = Date.now() - last;
    if (elapsed >= this.windowMs) return { allowed: true };

    return { allowed: false, retryAfterMs: this.windowMs - elapsed };
  }

  /** Record a successful pod creation for rate limiting. */
  record(userId: string): void {
    this.lastCreate.set(userId, Date.now());
  }

  /** Format a friendly wait message. */
  static formatWait(retryAfterMs: number): string {
    const minutes = Math.ceil(retryAfterMs / 60_000);
    return `Please wait ${minutes} minute${minutes === 1 ? "" : "s"} before creating another bot.`;
  }
}
