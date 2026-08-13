// Strictly serial async queue — the mechanism that makes TTS sequential
// (examiner waits for the patient to finish, never talks over). Pure logic,
// Node-smoke-tested in scripts/smoke-speech-logic.ts.

export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;

  /**
   * Runs `task` after everything enqueued before it has settled. Returns a
   * promise for THIS task (rejections propagate to the caller but never break
   * the chain). Tasks pending when clear() is called are skipped, not run.
   */
  enqueue(task: () => Promise<void>): Promise<void> {
    const gen = this.generation;
    const result = this.chain.then(() => (gen === this.generation ? task() : undefined));
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Drops everything not yet started. The currently running task (if any) is
   *  the caller's to cancel — the queue only guarantees no successor starts. */
  clear(): void {
    this.generation++;
  }
}
