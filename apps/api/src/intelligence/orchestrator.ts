// A DAG of read-only tools (master charter §10.2): each step names what it depends
// on, runs when they're done, in parallel where it can, under its own timeout and a
// plan-wide budget. A cycle or unknown tool is refused before anything runs. A tool
// can't reach anything but what's registered, and inputs are validated by the tool.

export interface Tool<C> {
  name: string;
  readOnly: true;
  timeoutMs: number;
  run(input: Record<string, unknown>, context: C, signal: AbortSignal): Promise<unknown>;
}

export interface PlanStep {
  id: string;
  tool: string;
  /** Plain values, or `{ $from: stepId }` to take another step's result. */
  input: Record<string, unknown>;
  after?: readonly string[];
}

export class PlanError extends Error {
  override name = 'PlanError';
}

export type StepResult = { ok: true; value: unknown; ms: number } | { ok: false; error: string; ms: number };

const MAX_STEPS = 32;

/** Refuses a plan that could never finish, in topological order for the run. */
export function checkPlan<C>(plan: readonly PlanStep[], tools: ReadonlyMap<string, Tool<C>>): void {
  if (plan.length > MAX_STEPS) throw new PlanError('too many steps');
  const ids = new Set(plan.map(s => s.id));
  if (ids.size !== plan.length) throw new PlanError('duplicate step');
  const state = new Map<string, 1 | 2>();
  const byId = new Map(plan.map(s => [s.id, s]));
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new PlanError('cycle');
    state.set(id, 1);
    for (const d of byId.get(id)?.after ?? []) {
      if (!ids.has(d)) throw new PlanError('unknown dependency');
      visit(d);
    }
    state.set(id, 2);
  };
  for (const s of plan) {
    if (!tools.has(s.tool)) throw new PlanError('unknown tool');
    visit(s.id);
  }
}

const resolve = (input: Record<string, unknown>, results: ReadonlyMap<string, StepResult>) =>
  Object.fromEntries(
    Object.entries(input).map(([k, v]) => {
      if (typeof v === 'object' && v !== null && '$from' in v) {
        const r = results.get(String(v.$from));
        return [k, r?.ok ? r.value : undefined];
      }
      return [k, v];
    }),
  );

export async function runPlan<C>(
  plan: readonly PlanStep[],
  tools: ReadonlyMap<string, Tool<C>>,
  context: C,
  budgetMs = 2_000,
): Promise<Map<string, StepResult>> {
  checkPlan(plan, tools);
  const results = new Map<string, StepResult>();
  const started = Date.now();
  const running = new Map<string, Promise<void>>();
  const start = (step: PlanStep): Promise<void> => {
    const existing = running.get(step.id);
    if (existing) return existing;
    const p = (async () => {
      await Promise.all((step.after ?? []).map(d => start(plan.find(s => s.id === d) as PlanStep)));
      const t = Date.now();
      const failedDep = (step.after ?? []).find(d => results.get(d)?.ok === false);
      const tool = tools.get(step.tool) as Tool<C>;
      const left = budgetMs - (t - started);
      if (failedDep) return void results.set(step.id, { ok: false, error: 'dependency failed', ms: 0 });
      if (left <= 0) return void results.set(step.id, { ok: false, error: 'out of time', ms: 0 });
      const signal = AbortSignal.timeout(Math.min(left, tool.timeoutMs));
      try {
        const value = await Promise.race([
          tool.run(resolve(step.input, results), context, signal),
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('timeout'));
            });
          }),
        ]);
        results.set(step.id, { ok: true, value, ms: Date.now() - t });
      } catch (err) {
        results.set(step.id, {
          ok: false,
          error: err instanceof Error && err.message === 'timeout' ? 'timeout' : 'failed',
          ms: Date.now() - t,
        });
      }
    })();
    running.set(step.id, p);
    return p;
  };
  await Promise.all(plan.map(start));
  return results;
}
