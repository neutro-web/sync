/**
 * VectorClockStrategy — the first ClockStrategy that returns "concurrent".
 *
 * Each instance represents one node in the system, identified by a caller-supplied
 * string node ID. Version shape: { _vec: Record<nodeId, number> } — a vector of
 * logical counters, one per node. Two versions are concurrent if neither's vector
 * dominates the other (neither has a component strictly greater than the other in
 * every dimension).
 *
 * `mint(prev?)` merges all entries from `prev`'s vector (capturing causal history)
 * then increments this node's own slot. A version minted with knowledge of `prev`
 * is always causally after `prev`. A version minted without knowledge of another
 * node's version is concurrent with that node's writes.
 *
 * Internal shape is strategy-owned and opaque to ns — only this file reads inside.
 */

import type { ClockStrategy, Version } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shape — opaque outside this module
// ---------------------------------------------------------------------------

interface VCVersionInternals {
  readonly _vec: Readonly<Record<string, number>>;
}

function asVC(v: Version): VCVersionInternals {
  return v as unknown as VCVersionInternals;
}

// ---------------------------------------------------------------------------
// VectorClockStrategy
// ---------------------------------------------------------------------------

export class VectorClockStrategy implements ClockStrategy {
  private readonly _nodeId: string;

  constructor(nodeId: string) {
    this._nodeId = nodeId;
  }

  mint(prev?: Version): Version {
    const prevVec = prev ? asVC(prev)._vec : {};
    const vec: Record<string, number> = { ...prevVec };
    vec[this._nodeId] = (vec[this._nodeId] ?? 0) + 1;
    return { _vec: vec } as unknown as Version;
  }

  compare(a: Version, b: Version): "before" | "after" | "concurrent" {
    const av = asVC(a)._vec;
    const bv = asVC(b)._vec;
    const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
    let aGtB = false;
    let bGtA = false;
    for (const k of keys) {
      const ai = av[k] ?? 0;
      const bi = bv[k] ?? 0;
      if (ai > bi) aGtB = true;
      if (bi > ai) bGtA = true;
    }
    if (aGtB && bGtA) return "concurrent";
    if (aGtB) return "after";
    if (bGtA) return "before";
    return "before"; // equal — idempotent re-apply
  }
}
