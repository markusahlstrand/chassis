/**
 * Per-scope actor: strict serialization (K-6). One operation runs to
 * completion before the next starts — the conservative semantics both
 * adapters can honor (the DO over-delivers via input gates; we deliver
 * exactly this).
 */
export class ScopeActor {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(op);
    // The chain must survive failures; callers still see the rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
