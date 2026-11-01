// Multi-gate mixture of experts (Ma et al., KDD 2018): several tasks share a few small networks, each with its own say
// in how much of each to use, so tasks that disagree don't fight over one shared layer. Written by hand in typed
// arrays. Compared with plain shared-bottom and independent models by benchmark-multitask (ADR 0032).
import { at } from './num.ts';
import { seededRandom } from './linalg.ts';

export interface MmoeOptions {
  inputs: number;
  tasks: number;
  experts?: number;
  hidden?: number;
  epochs?: number;
  rate?: number;
  seed?: number;
  /** One gate shared by every task: the shared-bottom baseline. */
  sharedGate?: boolean;
}

export interface Mmoe {
  inputs: number;
  tasks: number;
  experts: number;
  hidden: number;
  sharedGate: boolean;
  /** experts × hidden × inputs */
  expertWeights: Float64Array;
  /** gates × experts × inputs */
  gateWeights: Float64Array;
  /** tasks × hidden */
  towerWeights: Float64Array;
  towerBias: Float64Array;
}

interface Pass {
  activations: Float64Array;
  gates: Float64Array;
  mixed: Float64Array;
}

function forward(m: Mmoe, x: ArrayLike<number>, task: number, pass: Pass): number {
  const { experts, hidden, inputs } = m;
  for (let e = 0; e < experts; e++)
    for (let h = 0; h < hidden; h++) {
      let s = 0;
      for (let i = 0; i < inputs; i++) s += at(m.expertWeights, (e * hidden + h) * inputs + i) * at(x, i);
      pass.activations[e * hidden + h] = Math.max(0, s);
    }
  const gate = m.sharedGate ? 0 : task;
  let top = -Infinity;
  for (let e = 0; e < experts; e++) {
    let s = 0;
    for (let i = 0; i < inputs; i++) s += at(m.gateWeights, (gate * experts + e) * inputs + i) * at(x, i);
    pass.gates[e] = s;
    if (s > top) top = s;
  }
  let total = 0;
  for (let e = 0; e < experts; e++) {
    const p = Math.exp(at(pass.gates, e) - top);
    pass.gates[e] = p;
    total += p;
  }
  for (let e = 0; e < experts; e++) pass.gates[e] = at(pass.gates, e) / total;
  let logit = at(m.towerBias, task);
  for (let h = 0; h < hidden; h++) {
    let s = 0;
    for (let e = 0; e < experts; e++) s += at(pass.gates, e) * at(pass.activations, e * hidden + h);
    pass.mixed[h] = s;
    logit += at(m.towerWeights, task * hidden + h) * s;
  }
  return logit;
}

const newPass = (experts: number, hidden: number): Pass => ({
  activations: new Float64Array(experts * hidden),
  gates: new Float64Array(experts),
  mixed: new Float64Array(hidden),
});

/** Labels are 0 or 1 per task; a null label means this row says nothing about that task. */
export function trainMmoe(
  rows: ReadonlyArray<{ x: ArrayLike<number>; y: ReadonlyArray<number | null> }>,
  options: MmoeOptions,
): Mmoe {
  const { inputs, tasks, experts = 4, hidden = 8, epochs = 20, rate = 0.03 } = options;
  const sharedGate = options.sharedGate ?? false;
  const random = seededRandom(options.seed ?? 1);
  const init = (n: number, scale: number) => new Float64Array(n).map(() => (random() - 0.5) * scale);
  const m: Mmoe = {
    inputs,
    tasks,
    experts,
    hidden,
    sharedGate,
    expertWeights: init(experts * hidden * inputs, 0.5),
    gateWeights: init((sharedGate ? 1 : tasks) * experts * inputs, 0.1),
    towerWeights: init(tasks * hidden, 0.5),
    towerBias: new Float64Array(tasks),
  };
  const pass = newPass(experts, hidden);
  const order = Array.from(rows.keys());
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [at(order, j), at(order, i)];
    }
    for (const index of order) {
      const row = rows[index];
      if (!row) continue;
      for (let task = 0; task < tasks; task++) {
        const y = row.y[task];
        if (y === null || y === undefined) continue;
        const logit = forward(m, row.x, task, pass);
        const error = y - 1 / (1 + Math.exp(-logit));
        const step = rate * error;
        m.towerBias[task] = at(m.towerBias, task) + step;
        const gate = sharedGate ? 0 : task;
        let meanActivation = 0;
        const perExpert = new Float64Array(experts);
        for (let e = 0; e < experts; e++) {
          let s = 0;
          for (let h = 0; h < hidden; h++)
            s += at(m.towerWeights, task * hidden + h) * at(pass.activations, e * hidden + h);
          perExpert[e] = s;
          meanActivation += at(pass.gates, e) * s;
        }
        for (let e = 0; e < experts; e++) {
          const toward = at(pass.gates, e) * (at(perExpert, e) - meanActivation);
          for (let i = 0; i < inputs; i++) {
            const slot = (gate * experts + e) * inputs + i;
            m.gateWeights[slot] = at(m.gateWeights, slot) + step * toward * at(row.x, i);
          }
          for (let h = 0; h < hidden; h++) {
            if (at(pass.activations, e * hidden + h) <= 0) continue;
            const g = step * at(pass.gates, e) * at(m.towerWeights, task * hidden + h);
            for (let i = 0; i < inputs; i++) {
              const slot = (e * hidden + h) * inputs + i;
              m.expertWeights[slot] = at(m.expertWeights, slot) + g * at(row.x, i);
            }
          }
        }
        for (let h = 0; h < hidden; h++)
          m.towerWeights[task * hidden + h] = at(m.towerWeights, task * hidden + h) + step * at(pass.mixed, h);
      }
    }
  }
  return m;
}

export function predictMmoe(m: Mmoe, x: ArrayLike<number>, task: number): number {
  return 1 / (1 + Math.exp(-forward(m, x, task, newPass(m.experts, m.hidden))));
}

/** The charter's blend of task probabilities. Weights are a policy choice; dwell is on a log scale already. */
export const utility = (probabilities: readonly number[], weights: readonly number[]) =>
  probabilities.reduce((sum, p, i) => sum + p * at(weights, i), 0);
