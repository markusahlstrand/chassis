/**
 * Per-scope serialization (K-6). One operation runs to completion before the
 * next starts — the conservative semantics both adapters must honor. A Durable
 * Object's input gate "over-delivers" (it allows subtler interleavings around
 * non-storage awaits), so — exactly as the pure adapter does — the CF adapter
 * enforces strict serialization explicitly with a per-scope task queue rather
 * than trusting the gate. Kernel and module code may never depend on any
 * interleaving subtler than strict.
 *
 * Identical in spirit to `adapter-sqlite/src/actor.ts`; kept here so the DO owns
 * its own queue with no cross-package coupling.
 */
export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(op);
    // The chain must survive failures; callers still see the rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
