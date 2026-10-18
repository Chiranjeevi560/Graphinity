import { describe, expect, it } from 'vitest';
import { errorKind, serial } from '../src/jobs.ts';

describe('naming errors for logs', () => {
  it('gives the class name, never the message', () => {
    expect(errorKind(new TypeError('secret detail'))).toBe('TypeError');
    expect(errorKind('a thrown string with data')).toBe('unknown');
  });
});

describe('background runs, one at a time', () => {
  /** A task whose runs finish only when the test says so. */
  function controlled() {
    const finishers: Array<() => void> = [];
    const task = () => new Promise<void>(resolve => { finishers.push(resolve); });
    const finish = async () => { finishers.shift()?.(); await new Promise(r => setTimeout(r, 0)); };
    return { task, finish };
  }

  it('never overlaps, and runs once more after however many asks came in meanwhile', async () => {
    const t = controlled();
    let started = 0;
    const run = serial(() => { started += 1; return t.task(); });
    run(); run(); run(); run();
    expect(started).toBe(1);
    await t.finish();
    expect(started).toBe(2);
    await t.finish();
    expect(started).toBe(2);
    run();
    expect(started).toBe(3);
  });
});
