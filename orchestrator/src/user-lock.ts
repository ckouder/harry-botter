/**
 * Per-user mutex to prevent concurrent create/destroy race conditions.
 * In-memory Map-based — sufficient for single-process orchestrator.
 */

type Resolver = () => void;

export class UserLock {
  private locks = new Map<string, Promise<void>>();
  private queues = new Map<string, Resolver[]>();

  /**
   * Acquire a lock for a given user ID.
   * Returns a release function that MUST be called when done.
   */
  async acquire(userId: string): Promise<() => void> {
    while (this.locks.has(userId)) {
      await this.locks.get(userId);
    }

    let release!: Resolver;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(userId, promise);

    return () => {
      this.locks.delete(userId);
      release();
    };
  }
}
