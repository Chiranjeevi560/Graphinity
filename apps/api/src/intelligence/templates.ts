// Versioned templates with golden tests (master charter §10.2). A template's identity
// is its content hash, so what ran can always be named exactly and can't change
// silently; a new version must pass its golden set before it can be used. With no
// LLM serving (owner's decision), the registered "prompts" are extraction specs;
// the same harness guards any model prompt if one is ever added.
import { createHash } from 'node:crypto';

export interface Template {
  name: string;
  body: string;
  hash: string;
}

export const templateOf = (name: string, body: string): Template => ({
  name,
  body,
  hash: createHash('sha256').update(`${name}\u0000${body}`).digest('hex'),
});

export interface GoldenCase<I, O> {
  input: I;
  expected: O;
}

export interface GoldenReport {
  passed: number;
  total: number;
  failures: number[];
}

export function runGolden<I, O>(
  cases: ReadonlyArray<GoldenCase<I, O>>,
  run: (input: I) => O,
  equal: (a: O, b: O) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
): GoldenReport {
  const failures: number[] = [];
  cases.forEach((c, i) => {
    if (!equal(run(c.input), c.expected)) failures.push(i);
  });
  return { passed: cases.length - failures.length, total: cases.length, failures };
}

/** Immutable: the same name can hold many versions, but a hash never changes meaning. */
export class TemplateRegistry {
  private readonly versions = new Map<string, Template[]>();
  register<I, O>(t: Template, golden: ReadonlyArray<GoldenCase<I, O>>, run: (input: I) => O): GoldenReport {
    if (createHash('sha256').update(`${t.name}\u0000${t.body}`).digest('hex') !== t.hash)
      throw new Error('template hash mismatch');
    const report = runGolden(golden, run);
    if (report.failures.length > 0 || report.total === 0) return report;
    const list = this.versions.get(t.name) ?? [];
    if (!list.some(v => v.hash === t.hash)) list.push(t);
    this.versions.set(t.name, list);
    return report;
  }
  latest(name: string): Template | null {
    return this.versions.get(name)?.at(-1) ?? null;
  }
}
