// Springs described the way Apple describes them: a response (how quickly it
// gets there, in seconds) and a damping fraction (1 = no overshoot, lower =
// bouncier). A spring has no fixed duration; it emerges from these two.
//
// Gesture-driven motion runs the spring live (see Spring.step). Everything
// else uses a CSS linear() curve sampled from the same physics, so taps,
// hovers and route changes share one feel. CSS transitions restart from the
// element's current on-screen value, which keeps them interruptible.

export interface SpringParams {
  response: number;
  dampingFraction: number;
}

/** A spring as the spec writes it: m x'' + c x' + k x = 0. */
export interface SpringPhysics {
  mass: number;
  stiffness: number;
  damping: number;
}

/** The same spring in Apple's terms: ω = √(k/m), response = 2π/ω, ζ = c / 2√(mk). */
export function fromPhysics({ mass, stiffness, damping }: SpringPhysics): SpringParams {
  return {
    response: (2 * Math.PI) / Math.sqrt(stiffness / mass),
    dampingFraction: damping / (2 * Math.sqrt(mass * stiffness)),
  };
}

/** docs/SPEC.md §8.1, exactly as the table gives them. */
export const physics = {
  /** Presses, toggles, checkboxes: micro-interactions. */
  snappy: { mass: 1, stiffness: 380, damping: 34 },
  /** Sheets, dialogs, cards and screens arriving: panel morphs. */
  fluid: { mass: 1, stiffness: 260, damping: 28 },
  /** Gliding across the graph. */
  spatial: { mass: 1.2, stiffness: 140, damping: 24 },
  /** A person lighting up as a question reaches them. */
  pulse: { mass: 0.8, stiffness: 180, damping: 16 },
} as const satisfies Record<string, SpringPhysics>;

export const springs: Record<keyof typeof physics, SpringParams> = {
  snappy: fromPhysics(physics.snappy),
  fluid: fromPhysics(physics.fluid),
  spatial: fromPhysics(physics.spatial),
  pulse: fromPhysics(physics.pulse),
};

const SETTLE_DISTANCE = 0.001; // of the total distance
const SETTLE_VELOCITY = 0.01; // total distances per second

/**
 * Position of a spring moving from 0 to 1, starting at rest, at time t
 * (seconds). Closed-form solution for unit mass.
 */
export function springPosition({ response, dampingFraction: zeta }: SpringParams, t: number): number {
  const omega = (2 * Math.PI) / response; // natural frequency
  if (zeta >= 1) {
    // Critically damped (over-damped is treated the same; the spec has none).
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  }
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * t);
  return 1 - decay * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
}

function springVelocity(params: SpringParams, t: number): number {
  const h = 1e-4;
  return (springPosition(params, t + h) - springPosition(params, t)) / h;
}

/** Seconds until the spring is within 0.1% of its target and nearly still. */
export function settleTime(params: SpringParams): number {
  const dt = 1 / 240;
  for (let t = dt; t < 10; t += dt) {
    if (
      Math.abs(1 - springPosition(params, t)) < SETTLE_DISTANCE &&
      Math.abs(springVelocity(params, t)) < SETTLE_VELOCITY
    ) {
      return t;
    }
  }
  return 10;
}

/**
 * A CSS linear() easing that traces the spring, and the duration to pair it
 * with. Points are spaced evenly in time; 30 is visually indistinguishable
 * from the live spring at UI distances.
 */
export function springToCss(params: SpringParams, points = 30): { easing: string; durationMs: number } {
  const duration = settleTime(params);
  const values: string[] = [];
  for (let i = 0; i <= points; i++) {
    const v = i === points ? 1 : springPosition(params, (duration * i) / points);
    values.push(String(Math.round(v * 10_000) / 10_000));
  }
  return { easing: `linear(${values.join(', ')})`, durationMs: Math.round(duration * 1000) };
}

/**
 * A spring stepped frame by frame, for motion that follows a finger. It can
 * be re-targeted at any moment and keeps its current velocity, so reversing
 * mid-flight never hits a wall.
 */
export class Spring {
  value: number;
  velocity: number;
  target: number;
  readonly #stiffness: number;
  readonly #damping: number;

  constructor(params: SpringParams, initial: number, velocity = 0) {
    const omega = (2 * Math.PI) / params.response;
    this.#stiffness = omega * omega;
    this.#damping = 2 * params.dampingFraction * omega;
    this.value = initial;
    this.target = initial;
    this.velocity = velocity;
  }

  /** Advance by dt seconds. Returns true once settled. */
  step(dt: number): boolean {
    // Sub-step for stability when a frame is long (tab switch, jank).
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const force = -this.#stiffness * (this.value - this.target) - this.#damping * this.velocity;
      this.velocity += force * h; // semi-implicit Euler: velocity first
      this.value += this.velocity * h;
    }
    const scale = Math.max(1, Math.abs(this.target));
    if (
      Math.abs(this.value - this.target) < SETTLE_DISTANCE * scale &&
      Math.abs(this.velocity) < SETTLE_VELOCITY * scale
    ) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}
