/**
 * Mulberry32 seeded PRNG.
 *
 * Deterministic and fast. All fault decisions in ChannelSimulator go through
 * this so that a failing run can be reproduced exactly from its seed.
 *
 * Returns a closure that yields floats in [0, 1) on each call.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}
