// Small pieces shared by the background work the server runs.

/** What kind of error, for logs: its class name, never its message (which can hold data). */
export function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * Runs `task` one at a time. Asking while it runs schedules exactly one more
 * run straight after, however many times it was asked: the next run picks up
 * everything that came in meanwhile. Failures are the task's to handle.
 */
export function serial(task: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void task().finally(() => {
      running = false;
      if (again) {
        again = false;
        run();
      }
    });
  };
  return run;
}
