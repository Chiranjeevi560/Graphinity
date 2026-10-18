import { describe, expect, it } from 'vitest';
import { parseEvents, type LiveEvent } from '../src/lib/live.ts';

describe('reading live events', () => {
  it('reads whole messages and keeps a half-received one for later', () => {
    const got: LiveEvent[] = [];
    const rest = parseEvents(': connected\n\nevent: answered\ndata: {"questionId":"42"}\n\nevent: routed\ndata: {"questi', e => got.push(e));
    expect(got).toEqual([{ type: 'answered', questionId: '42' }]);
    expect(parseEvents(`${rest}onId":"7"}\n\n`, e => got.push(e))).toBe('');
    expect(got).toEqual([{ type: 'answered', questionId: '42' }, { type: 'routed', questionId: '7' }]);
  });

  it('ignores unknown events, pings, broken data and ids that aren’t ids', () => {
    const got: LiveEvent[] = [];
    parseEvents(': ping\n\nevent: other\ndata: {"questionId":"1"}\n\nevent: answered\ndata: not json\n\nevent: answered\ndata: {"questionId":"../me"}\n\n', e => got.push(e));
    expect(got).toEqual([]);
  });
});
