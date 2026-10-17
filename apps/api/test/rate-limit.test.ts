import { describe, expect, it } from 'vitest';
import { TokenBuckets, visitorAddress, visitorKey } from '../src/rate-limit.ts';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('TokenBuckets', () => {
  it('allows a burst up to capacity, then refuses with a retry time', () => {
    const clock = fakeClock();
    const b = new TokenBuckets({ capacity: 3, refillPerSecond: 1, maxKeys: 10 }, clock);
    expect([b.take('a'), b.take('a'), b.take('a')].every(r => r.ok)).toBe(true);
    expect(b.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('refills over time, never beyond capacity', () => {
    const clock = fakeClock();
    const b = new TokenBuckets({ capacity: 2, refillPerSecond: 1, maxKeys: 10 }, clock);
    b.take('a'); b.take('a');
    expect(b.take('a').ok).toBe(false);
    clock.advance(1_000);
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
    clock.advance(60_000);
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
  });

  it('keeps visitors separate', () => {
    const b = new TokenBuckets({ capacity: 1, refillPerSecond: 1, maxKeys: 10 }, fakeClock());
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
    expect(b.take('b').ok).toBe(true);
  });

  it('forgets the least recently used key once full, so memory stays bounded', () => {
    const b = new TokenBuckets({ capacity: 1, refillPerSecond: 0.001, maxKeys: 2 }, fakeClock());
    b.take('a'); b.take('b');
    b.take('a'); // touch a, so b is now the oldest
    b.take('c'); // evicts b
    expect(b.size).toBe(2);
    expect(b.take('a').ok).toBe(false); // still remembered and empty
    expect(b.take('b').ok).toBe(true); // forgotten, so fresh
  });

  it('a refused request still records the time, so hammering does not earn tokens', () => {
    const clock = fakeClock();
    const b = new TokenBuckets({ capacity: 1, refillPerSecond: 1, maxKeys: 10 }, clock);
    b.take('a');
    clock.advance(500);
    expect(b.take('a').ok).toBe(false);
    clock.advance(500);
    expect(b.take('a').ok).toBe(true);
  });
});

describe('TokenBuckets when the clock steps backwards', () => {
  it('does not lock a visitor out', () => {
    const clock = fakeClock();
    const b = new TokenBuckets({ capacity: 2, refillPerSecond: 1, maxKeys: 10 }, clock);
    b.take('a');
    clock.advance(-7 * 24 * 3600 * 1000); // e.g. a time sync correction
    expect(b.take('a').ok).toBe(true);
  });
});

describe('visitorKey', () => {
  const key = Buffer.alloc(32, 7);

  it('is stable for the same address and differs between addresses', () => {
    expect(visitorKey('203.0.113.5', key)).toBe(visitorKey('203.0.113.5', key));
    expect(visitorKey('203.0.113.5', key)).not.toBe(visitorKey('203.0.113.6', key));
  });

  it('never contains the address', () => {
    expect(visitorKey('203.0.113.5', key)).not.toContain('203');
  });

  it('depends on the secret key, so it cannot be reversed by hashing every address', () => {
    expect(visitorKey('203.0.113.5', key)).not.toBe(visitorKey('203.0.113.5', Buffer.alloc(32, 8)));
  });
});

describe('visitorAddress', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(visitorAddress('203.0.113.5')).toBe('203.0.113.5');
  });

  it('unwraps IPv4 written as IPv6', () => {
    expect(visitorAddress('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('groups an IPv6 address by its /64 block, which one connection controls', () => {
    const a = visitorAddress('2001:db8:abcd:12:1111:2222:3333:4444');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(visitorAddress('2001:db8:abcd:12:ffff:ffff:ffff:ffff')).toBe(a);
    expect(visitorAddress('2001:db8:abcd:12::1')).toBe(a);
    expect(visitorAddress('2001:DB8:ABCD:0012::9')).toBe(a);
  });

  it('keeps different /64 blocks apart, including compressed forms', () => {
    expect(visitorAddress('2001:db8:abcd:13::1')).not.toBe(visitorAddress('2001:db8:abcd:12::1'));
    expect(visitorAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(visitorAddress('::1')).toBe('0:0:0:0::/64');
  });
});
