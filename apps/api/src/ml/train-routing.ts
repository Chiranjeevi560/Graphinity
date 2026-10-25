// One training run of learned routing (ADR 0013), as a pure function of its
// input: hold out one question in five, train both stages on the rest, and
// judge the candidate against Ψ (and the serving model) on the held-out
// questions asked since the last rejection. Runs unchanged on the worker.
import {
  calibrationVerdict,
  decideRouting,
  isRoutingHeldOut,
  psiScore,
  strata,
  stratumAucs,
  type GateExample,
  type RoutingDecision,
} from './routing-gate.ts';
import {
  deserializeRoutingModel,
  ROUTING_ALGORITHM,
  scoreRouting,
  scoreRoutingAt,
  serializeRoutingModel,
  trainRoutingModel,
  type RoutingModel,
} from './routing-model.ts';

export interface RoutingInput {
  examples: GateExample[];
  serving: { version: number; artifact: Uint8Array } | null;
  /** When the last measured rejection was recorded (ms): only questions asked after it are judged. */
  since: number | null;
  /** How many of the routes a learned model ranked (it learns partly from its own choices). */
  modelRanked?: number;
}

export interface RoutingResult {
  decision: RoutingDecision;
  params: {
    lambdaAvailability: number;
    lambdaQuality: number;
    constant: string[];
    trustLevels: number;
    converged: boolean;
  };
  dataset: { trainingRoutes: number; heldOutRoutes: number; trainingQuestions: number; modelRankedRoutes: number };
  metrics: { candidateAuc: number; psiAuc: number; askers: number; strata: number; trainMs: number };
  baseline: { kind: 'psi' | 'model'; version: number | null; psiAuc: number; servingAuc: number | null };
  artifact: Uint8Array | null;
}

export function trainRoutingAndEvaluate(input: RoutingInput): RoutingResult {
  const training = input.examples.filter(e => !isRoutingHeldOut(e.questionId));
  const heldOut = input.examples.filter(e => isRoutingHeldOut(e.questionId));
  const started = performance.now();
  const model: RoutingModel = trainRoutingModel(training);
  const trainMs = Math.round(performance.now() - started);
  const judged = strata(heldOut, input.since);
  const serving = input.serving ? deserializeRoutingModel(Buffer.from(input.serving.artifact)) : null;
  const ranked = decideRouting(
    judged,
    stratumAucs(judged, f => scoreRouting(model, f)),
    stratumAucs(judged, psiScore),
    serving ? stratumAucs(judged, f => scoreRouting(serving, f)) : null,
    model,
  );
  // The same check the daily monitor retires a serving model by, on held-out judged routes at
  // their real waves: a model that would be retired mustn't be promoted.
  const calibration = calibrationVerdict(
    heldOut.filter(e => e.judged).map(e => ({ predicted: scoreRoutingAt(model, e.factors, e.wave), helped: e.helped })),
  );
  const decision =
    ranked.promote && calibration.demote
      ? { ...ranked, promote: false, reason: `ranks well but is miscalibrated: ${calibration.reason}` }
      : ranked;
  return {
    decision,
    params: {
      lambdaAvailability: model.availability.lambda,
      lambdaQuality: model.quality.lambda,
      constant: model.constant,
      trustLevels: model.trustLevels,
      converged: model.availability.converged && model.quality.converged,
    },
    dataset: {
      trainingRoutes: training.length,
      heldOutRoutes: heldOut.length,
      trainingQuestions: new Set(training.map(e => e.questionId)).size,
      modelRankedRoutes: input.modelRanked ?? 0,
    },
    metrics: {
      candidateAuc: decision.candidateAuc,
      psiAuc: decision.psiAuc,
      askers: decision.askers,
      strata: decision.strata,
      trainMs,
    },
    baseline: {
      kind: serving ? 'model' : 'psi',
      version: input.serving?.version ?? null,
      psiAuc: decision.psiAuc,
      servingAuc: decision.servingAuc,
    },
    artifact: decision.promote ? new Uint8Array(serializeRoutingModel(model)) : null,
  };
}

export { ROUTING_ALGORITHM };
