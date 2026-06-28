/**
 * Last-Writer-Wins ClockStrategy.
 *
 * Versions carry two fields: `_ts` (a Lamport-style monotonic counter) and
 * `_node` (a per-instance identifier used as a deterministic tiebreaker).
 * Together they produce a strict total order with no `"concurrent"` return —
 * LWW's defining property.
 *
 * ## Tiebreaking across independent instances
 * Two separate `LWWClockStrategy` instances can independently mint the same
 * `_ts` (e.g., both start at 0 and each calls `mint()` once without `prev`).
 * The `_node` ID — assigned from a module-level counter at construction time,
 * or supplied explicitly — breaks ties deterministically: the higher `_node`
 * wins. An identical `(_ts, _node)` pair is idempotent (treated as `"before"`).
 *
 * ## Lamport clock advance
 * `mint(prev?)` advances the counter past any previously-seen version:
 * `_counter = max(_counter, prev._ts) + 1`. Consumers who pass their last
 * received version as `prev` produce a version strictly newer than it,
 * minimising `_ts` collisions in a gossip topology.
 *
 * Internal version shape: `{ _ts: number, _node: number }`. Strategy-owned
 * and opaque to `ns` — only this file reads inside.
 */

import type { ClockStrategy, Version } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shape — opaque outside this module
// ---------------------------------------------------------------------------

interface LWWVersionInternals {
  readonly _ts: number;
  readonly _node: number;
}

function asLWW(v: Version): LWWVersionInternals {
  return v as unknown as LWWVersionInternals;
}

// Module-level counter — each LWWClockStrategy instance gets a unique node id.
let _instanceCounter = 0;

// ---------------------------------------------------------------------------
// LWWClockStrategy
// ---------------------------------------------------------------------------

export class LWWClockStrategy implements ClockStrategy {
  private _counter = 0;
  private readonly _node: number;

  /**
   * @param nodeId Optional explicit node identifier. When omitted, a unique id
   * is auto-assigned from a module-level counter. Pass an explicit value in
   * tests that require deterministic tiebreaking order.
   */
  constructor(nodeId?: number) {
    this._node = nodeId ?? _instanceCounter++;
  }

  /**
   * Mint a new version token. Advances the internal counter past `prev`
   * (Lamport-style): the result is always strictly newer than `prev`.
   * Without `prev`, increments the counter from its current position.
   */
  mint(prev?: Version): Version {
    this._counter = Math.max(this._counter, prev ? asLWW(prev)._ts : 0) + 1;
    return { _ts: this._counter, _node: this._node } as unknown as Version;
  }

  /**
   * Compare two versions. Returns `"after"` or `"before"`; **never returns
   * `"concurrent"`** — that is LWW's defining property.
   *
   * Ordering: first by `_ts` (higher wins); on equal `_ts`, by `_node`
   * (higher wins). An identical `(_ts, _node)` pair is treated as `"before"`
   * (idempotent re-apply).
   */
  compare(a: Version, b: Version): "before" | "after" | "concurrent" {
    const av = asLWW(a);
    const bv = asLWW(b);
    if (av._ts !== bv._ts) return av._ts > bv._ts ? "after" : "before";
    if (av._node !== bv._node) return av._node > bv._node ? "after" : "before";
    return "before"; // identical token — idempotent re-apply
  }
}
