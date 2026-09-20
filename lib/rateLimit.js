// A token bucket gives callers a small burst and then gradually restores
// capacity, avoiding the sharp false-positive boundary of a fixed window.
export function makeThrottle({ burst, refillMs, maxTrackedIps = 5000, now = () => Date.now() }) {
  const buckets = new Map(); // key -> { tokens, last }

  return (key) => {
    const current = now();
    const seen = buckets.get(key);

    if (!seen) {
      // Sweep fully-refilled (idle) entries before adding a new one, so a long
      // tail of one-off callers cannot make the map grow without bound.
      if (buckets.size >= maxTrackedIps) {
        for (const [trackedKey, value] of buckets) {
          if (current - value.last >= burst * refillMs) buckets.delete(trackedKey);
        }
      }
      buckets.set(key, { tokens: burst - 1, last: current });
      return false;
    }

    const refilled = Math.min(burst, seen.tokens + (current - seen.last) / refillMs);
    if (refilled < 1) {
      seen.tokens = refilled;
      seen.last = current;
      return true;
    }
    seen.tokens = refilled - 1;
    seen.last = current;
    return false;
  };
}