import { checkRateLimit, trackRequest, resetUsage } from './usage-service.js';

/**
 * Regression tests for the rate limiter.
 *
 * An earlier implementation compared a lifetime-cumulative request count
 * against the per-minute limit, which permanently rate-limited any long
 * agentic session once the total was exceeded.
 */
describe('checkRateLimit', () => {
  it('allows requests up to the limit', () => {
    const session = `s-${Math.random()}`;

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(session, 5).limited).toBe(false);
    }
  });

  it('limits once the window is full', () => {
    const session = `s-${Math.random()}`;

    for (let i = 0; i < 3; i++) checkRateLimit(session, 3);

    const result = checkRateLimit(session, 3);
    expect(result.limited).toBe(true);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('does not limit based on lifetime totals', () => {
    const session = `s-${Math.random()}`;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;

    try {
      // Far exceed the limit in total, but spread across separate windows.
      for (let batch = 0; batch < 20; batch++) {
        for (let i = 0; i < 10; i++) {
          expect(checkRateLimit(session, 10).limited).toBe(false);
        }
        clock += 61_000;
      }
    } finally {
      Date.now = realNow;
    }
  });

  it('recovers after the window elapses', () => {
    const session = `s-${Math.random()}`;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;

    try {
      for (let i = 0; i < 2; i++) checkRateLimit(session, 2);
      expect(checkRateLimit(session, 2).limited).toBe(true);

      clock += 61_000;
      expect(checkRateLimit(session, 2).limited).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('tracks sessions independently', () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;

    for (let i = 0; i < 2; i++) checkRateLimit(a, 2);

    expect(checkRateLimit(a, 2).limited).toBe(true);
    expect(checkRateLimit(b, 2).limited).toBe(false);
  });

  it('is unaffected by token tracking', () => {
    const session = `s-${Math.random()}`;

    trackRequest(session, 5000);
    trackRequest(session, 5000);

    expect(checkRateLimit(session, 10).limited).toBe(false);
    resetUsage(session);
  });
});
