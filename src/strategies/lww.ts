/**
 * Last-Writer-Wins ClockStrategy.
 *
 * Versions are monotonic integers minted by a per-instance counter.
 * `compare()` returns `"before"` or `"after"`; it **never** returns `"concurrent"` —
 * that is LWW's defining property. The `concurrent` arm in `Engine.apply()` is
 * unreachable under this strategy. Phase 2 (logical clock, CRDT position) introduces
 * strategies where `concurrent` is the common case.
 *
 * Internal version shape: `{ _ts: number }`. The `_ts` field is a monotonically
 * increasing integer (not a wall-clock timestamp) to ensure fully deterministic
 * behaviour in tests. Strategy-owned and opaque to `ns` — only this file reads inside.
 */

import type { ClockStrategy, Version } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shape — opaque outside this module
// ---------------------------------------------------------------------------

interface LWWVersionInternals {
  readonly _ts: number;
}

function getTs(v: Version): number {
  return (v as unknown as LWWVersionInternals)._ts;
}

// ---------------------------------------------------------------------------
// LWWClockStrategy
// ---------------------------------------------------------------------------

export class LWWClockStrategy implements ClockStrategy {
  private _counter = 0;

  /**
   * Mint a new version token. Each call increments the counter, so versions
   * from the same instance are strictly ordered (later mint > earlier mint).
   * `prev` is accepted per the interface but not used — LWW has no ancestry.
   */
  mint(_prev?: Version): Version {
    return { _ts: ++this._counter } as unknown as Version;
  }

  /**
   * Compare two versions.
   * - Returns `"after"` if `a` is strictly newer than `b`.
   * - Returns `"before"` for all other cases (a is older, or equal).
   * - **Never returns `"concurrent"`** — equal timestamps are treated as
   *   `"before"` (re-applying the same version is a no-op; first write wins
   *   on exact tie, which cannot occur with per-instance monotonic counters).
   */
  compare(a: Version, b: Version): "before" | "after" | "concurrent" {
    const at = getTs(a);
    const bt = getTs(b);
    return at > bt ? "after" : "before";
  }
}
