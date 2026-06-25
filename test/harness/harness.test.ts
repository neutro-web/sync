/**
 * Phase 1 convergence harness — gate tests.
 *
 * Maps to docs/gates/phase1-convergence-harness.md:
 *   G1  Harness catches divergence on non-converging stub
 *   G2  Harness is not vacuously red
 *   G3  Deterministic runs (same seed → identical stats)
 *   G4  Channel faults are actually injected (drop / dup / partition / reorder)
 *   G5  Convergence assertion operates on ≥2 replicas
 *   G6  tsc --noEmit + vitest both exit 0 (vitest half is this file passing)
 */

import { describe, it, expect } from "vitest";
import { ConvergenceHarness } from "./convergence-harness.ts";
import {
  makeChangeId,
  makeScope,
  makeConflictUnit,
  DURABLE,
} from "../../src/core/types.ts";
import { makeStubVersion } from "./stubs.ts";
import type { ChangeBatch } from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 1;
function nextBatch(
  scopeKey: string,
  unitKey: string,
  value: unknown,
  seq?: number,
): ChangeBatch {
  const s = seq ?? _seq++;
  return {
    scope: makeScope(scopeKey),
    changes: [
      {
        id: makeChangeId(`c-${scopeKey}-${unitKey}-${s}`),
        scope: makeScope(scopeKey),
        unit: makeConflictUnit(unitKey),
        kind: "state",
        lifetime: DURABLE,
        value,
        version: makeStubVersion(s),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// G1 — Harness catches divergence on non-converging stub
// ---------------------------------------------------------------------------

describe("Gate 1 · Harness reports divergence on non-converging stub", () => {
  it("reports converged: false when replicas have conflicting values and no transport", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "non-converging",
      channelSeed: 1,
    });

    // Both replicas write different values to the same (scope, unit).
    await h.applyLocal(0, nextBatch("doc-1", "u1", "from-R0", 10));
    await h.applyLocal(1, nextBatch("doc-1", "u1", "from-R1", 20));

    // Drain does nothing — non-converging feed never enqueues anything.
    await h.drainToQuiescence();

    const result = h.assertConverged();
    expect(result.converged).toBe(false);
    expect(result.divergences.length).toBeGreaterThan(0);
    expect(result.divergences[0]!.scopeKey).toBe("doc-1");
    expect(result.divergences[0]!.unitKey).toBe("u1");
  });
});

// ---------------------------------------------------------------------------
// G2 — Harness is not vacuously red
// ---------------------------------------------------------------------------

describe("Gate 2 · Harness reports convergence on trivially-correct stub", () => {
  it("reports converged: true for disjoint writes over a perfect channel", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "trivially-correct",
      channelSeed: 2,
      faultConfig: { dropRate: 0, reorderRate: 0, duplicateRate: 0 },
    });

    // Disjoint writes — no LWW conflict, just gossip needed.
    await h.applyLocal(0, nextBatch("doc-1", "u1", "value-from-R0", 100));
    await h.applyLocal(1, nextBatch("doc-1", "u2", "value-from-R1", 200));

    await h.drainToQuiescence();

    const result = h.assertConverged();
    expect(result.converged).toBe(true);
    expect(result.divergences).toHaveLength(0);

    // Both replicas should have both units.
    const r0 = h.getReplicaState(0);
    const r1 = h.getReplicaState(1);
    expect(r0.state.get("doc-1")?.get("u1")).toBe("value-from-R0");
    expect(r0.state.get("doc-1")?.get("u2")).toBe("value-from-R1");
    expect(r1.state.get("doc-1")?.get("u1")).toBe("value-from-R0");
    expect(r1.state.get("doc-1")?.get("u2")).toBe("value-from-R1");
  });
});

// ---------------------------------------------------------------------------
// G3 — Deterministic runs
// ---------------------------------------------------------------------------

describe("Gate 3 · Deterministic runs", () => {
  it("produces identical channel stats for two runs with the same seed", async () => {
    const SEED = 99;
    const fault = { dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 };
    const batches: [string, string, unknown, number][] = [
      ["doc-1", "u1", "aaa", 300],
      ["doc-1", "u2", "bbb", 301],
      ["doc-1", "u3", "ccc", 302],
    ];

    async function runHarness() {
      const h = new ConvergenceHarness({
        replicaCount: 2,
        feedKind: "trivially-correct",
        channelSeed: SEED,
        faultConfig: fault,
      });
      for (const [sk, uk, val, seq] of batches) {
        await h.applyLocal(0, nextBatch(sk, uk, val, seq));
      }
      await h.drainToQuiescence();
      return h.getTotalChannelStats();
    }

    const statsA = await runHarness();
    const statsB = await runHarness();

    expect(statsA).toEqual(statsB);
  });
});

// ---------------------------------------------------------------------------
// G4 — Channel faults are actually injected
// ---------------------------------------------------------------------------

describe("Gate 4 · Channel faults are actually injected", () => {
  it("G4a: dropRate 1.0 → stats.dropped > 0 and stats.delivered === 0", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "trivially-correct",
      channelSeed: 40,
      faultConfig: { dropRate: 1.0 },
    });

    await h.applyLocal(0, nextBatch("doc-1", "u1", "v1", 400));
    await h.applyLocal(0, nextBatch("doc-1", "u2", "v2", 401));
    await h.drainToQuiescence();

    const stats = h.getTotalChannelStats();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.delivered).toBe(0);
  });

  it("G4b: duplicateRate 1.0 → stats.duplicated > 0 and feed still converges (idempotent)", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "trivially-correct",
      channelSeed: 41,
      faultConfig: { duplicateRate: 1.0 },
    });

    await h.applyLocal(0, nextBatch("doc-1", "u1", "dedup-me", 410));
    await h.drainToQuiescence();

    const stats = h.getTotalChannelStats();
    expect(stats.duplicated).toBeGreaterThan(0);

    const result = h.assertConverged();
    expect(result.converged).toBe(true);
  });

  it("G4c: partition → drain (no delivery) → reconnect → drain (delivery)", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "trivially-correct",
      channelSeed: 42,
    });

    h.partitionAll();
    await h.applyLocal(0, nextBatch("doc-1", "u1", "while-partitioned", 420));

    // Drain while partitioned — R1 should NOT see the value yet.
    await h.drainToQuiescence();
    const r1Before = h.getReplicaState(1);
    expect(r1Before.state.get("doc-1")?.get("u1")).toBeUndefined();

    // Reconnect and drain — R1 should now receive the buffered batch.
    h.reconnectAll();
    await h.drainToQuiescence();
    const r1After = h.getReplicaState(1);
    expect(r1After.state.get("doc-1")?.get("u1")).toBe("while-partitioned");
  });

  it("G4d: reorderRate 1.0, 3 batches before any drain → stats.reordered > 0", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 2,
      feedKind: "trivially-correct",
      channelSeed: 43,
      faultConfig: { reorderRate: 1.0 },
    });

    // Enqueue 3 batches without draining between them so reorder has pending
    // entries to insert before.
    await h.applyLocal(0, nextBatch("doc-1", "u1", "first",  430));
    await h.applyLocal(0, nextBatch("doc-1", "u2", "second", 431));
    await h.applyLocal(0, nextBatch("doc-1", "u3", "third",  432));

    await h.drainToQuiescence();

    const stats = h.getTotalChannelStats();
    expect(stats.reordered).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G5 — Convergence assertion operates on ≥2 replicas
// ---------------------------------------------------------------------------

describe("Gate 5 · Convergence assertion requires ≥2 replicas", () => {
  it("G5a: 3-replica disjoint writes converge on a perfect channel", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 3,
      feedKind: "trivially-correct",
      channelSeed: 50,
      faultConfig: { dropRate: 0, reorderRate: 0, duplicateRate: 0 },
    });

    await h.applyLocal(0, nextBatch("doc-1", "u1", "r0-val", 500));
    await h.applyLocal(1, nextBatch("doc-1", "u2", "r1-val", 501));
    await h.applyLocal(2, nextBatch("doc-1", "u3", "r2-val", 502));

    await h.drainToQuiescence();

    const result = h.assertConverged();
    expect(result.converged).toBe(true);
    expect(result.divergences).toHaveLength(0);

    // All three replicas have all three values.
    for (let i = 0; i < 3; i++) {
      const state = h.getReplicaState(i).state.get("doc-1");
      expect(state?.get("u1")).toBe("r0-val");
      expect(state?.get("u2")).toBe("r1-val");
      expect(state?.get("u3")).toBe("r2-val");
    }
  });

  it("G5b: 1-replica harness throws on assertConverged() (spike rule)", () => {
    const h = new ConvergenceHarness({
      replicaCount: 1,
      feedKind: "trivially-correct",
      channelSeed: 51,
    });

    expect(() => h.assertConverged()).toThrow(/≥2 replicas/);
  });

  it("G5c: 3 non-converging replicas writing conflicting values → converged: false", async () => {
    const h = new ConvergenceHarness({
      replicaCount: 3,
      feedKind: "non-converging",
      channelSeed: 52,
    });

    // All three write different values to the same unit — no transport to reconcile.
    await h.applyLocal(0, nextBatch("doc-1", "u1", "val-from-R0", 520));
    await h.applyLocal(1, nextBatch("doc-1", "u1", "val-from-R1", 521));
    await h.applyLocal(2, nextBatch("doc-1", "u1", "val-from-R2", 522));

    await h.drainToQuiescence();

    const result = h.assertConverged();
    expect(result.converged).toBe(false);
    expect(result.divergences.length).toBeGreaterThan(0);
  });
});
