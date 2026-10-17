import { describe, expect, it } from 'vitest';
import { MIN_CAMO_WEIGHT, normalizeWeights } from './project';

describe('normalizeWeights', () => {
  it('sums to 1, floors every share at MIN_CAMO_WEIGHT, keeps a pinned share exact', () => {
    for (const w of [[1, 1], [0.001, 5, 5, 5], [0.0001, 0.0001, 0.0001, 1], [3, 1, 1]]) {
      const n = normalizeWeights(w);
      expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      for (const v of n) expect(v).toBeGreaterThanOrEqual(MIN_CAMO_WEIGHT);
      expect(normalizeWeights(n)).toEqual(n);
    }
    expect(normalizeWeights([0.0001, 0.0001, 0.0001, 1])).toEqual([0.05, 0.05, 0.05, 0.85]);
    expect(normalizeWeights([1, 2])).toEqual([0.3333, 0.6667]);
  });
});
