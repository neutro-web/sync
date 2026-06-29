/**
 * Phase 3 gate tests — C1-C7.
 * Design basis: docs/design/merge-resolution.md (Q-C crux: max-only join).
 * Gate contract: docs/gates/phase3-merge-resolution.md
 */

import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import {
  makeChangeId,
  makeScope,
  makeConflictUnit,
  DURABLE,
  ephemeral,
} from "../../src/core/types.ts";
import type {
  ChangeBatch,
  Scope,
  Version,
  ConflictUnit,
  Conflict,
  Resolution,
  ClockStrategy,
} from "../../src/core/types.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SCOPE = makeScope("doc-1");
const UNIT = makeConflictUnit("field-x");

function makeDurableStateBatch(
  scope: Scope,
  unit: ConflictUnit,
  value: unknown,
  id: string,
  version: Version,
): ChangeBatch {
  return {
    scope,
    changes: [
      {
        id: makeChangeId(id),
        scope,
        unit,
        kind: "state",
        lifetime: DURABLE,
        value,
        version,
      },
    ],
  };
}

async function getUnitValue(
  engine: Engine,
  scope: Scope,
  unit: ConflictUnit,
): Promise<unknown> {
  const snap = await engine.snapshot(scope);
  const change = snap.changes.find((c) => c.unit.key === unit.key);
  return change?.value;
}

async function getUnitVersion(
  engine: Engine,
  scope: Scope,
  unit: ConflictUnit,
): Promise<Version | undefined> {
  const snap = await engine.snapshot(scope);
  const change = snap.changes.find(
    (c) => c.unit.key === unit.key && c.kind === "state",
  );
  return change?.kind === "state" ? change.version : undefined;
}

/**
 * Wire N engines in a full gossip mesh via ChannelSimulator.
 * Returns { allChannels, drainChannels, throwIfErrors }.
 */
function setupGossip(
  engines: Engine[],
  scope: Scope,
  baseSeed: number,
  faultConfig?: FaultConfig,
): {
  channels: Map<string, ChannelSimulator>;
  allChannels: ChannelSimulator[];
  throwIfErrors(): void;
} {
  const n = engines.length;
  const channels = new Map<string, ChannelSimulator>();
  const deliveryErrors: unknown[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      channels.set(
        `${i}→${j}`,
        new ChannelSimulator(baseSeed + i * 100 + j, faultConfig),
      );
    }
  }

  for (let i = 0; i < n; i++) {
    const ci = i;
    engines[i]!.subscribe(scope, {
      onBatch: (batch) => {
        for (let j = 0; j < n; j++) {
          if (j === ci) continue;
          channels.get(`${ci}→${j}`)!.enqueue(batch, (b) => {
            engines[j]!.apply(b).catch((err) => deliveryErrors.push(err));
          });
        }
      },
      onConflict: () => ({ decision: "defer" as const }),
    });
  }

  return {
    channels,
    allChannels: Array.from(channels.values()),
    throwIfErrors(): void {
      if (deliveryErrors.length > 0) throw deliveryErrors[0];
    },
  };
}

async function drainChannels(
  channels: ChannelSimulator[],
  maxRounds = 200,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    let delivered = 0;
    for (const ch of channels) delivered += ch.drain();
    await Promise.resolve();
    if (delivered === 0) return;
  }
  throw new Error(`drainChannels: did not quiesce after ${maxRounds} rounds`);
}

// ---------------------------------------------------------------------------
// C2 — VectorClockStrategy.mergeVersions
// ---------------------------------------------------------------------------

describe("C2 · VectorClockStrategy.mergeVersions", () => {
  const clockA = new VectorClockStrategy("node-A");
  const clockB = new VectorClockStrategy("node-B");
  const clockC = new VectorClockStrategy("node-C");

  const vA = clockA.mint(); // { node-A: 1 }
  const vB = clockB.mint(); // { node-B: 1 }

  it("mergeVersions is defined on VectorClockStrategy", () => {
    expect(typeof clockA.mergeVersions).toBe("function");
  });

  it("merged version dominates a (compare returns after)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vA)).toBe("after");
  });

  it("merged version dominates b (compare returns after)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vB)).toBe("after");
  });

  it("order-independent: merge(a,b) compare-equals merge(b,a)", () => {
    const mergeAB = clockA.mergeVersions!(vA, vB);
    const mergeBA = clockA.mergeVersions!(vB, vA);
    // compare-equal means neither is strictly after the other
    expect(clockA.compare(mergeAB, mergeBA)).toBe("before"); // equal → before (idempotent)
    expect(clockA.compare(mergeBA, mergeAB)).toBe("before");
  });

  it("original input a compares before merged (redelivery is skipped)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(vA, merged)).toBe("before");
  });

  it("original input b compares before merged (redelivery is skipped)", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(vB, merged)).toBe("before");
  });

  it("post-merge local write dominates the merged version", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    const postMerge = clockA.mint(merged); // mint after knowing about merged
    expect(clockA.compare(postMerge, merged)).toBe("after");
  });

  it("N-way: merge(merge(a,b), c) dominates a, b, and c", () => {
    const vC = clockC.mint(); // { node-C: 1 }
    const mergeAB = clockA.mergeVersions!(vA, vB);
    const mergeABC = clockA.mergeVersions!(mergeAB, vC);
    expect(clockA.compare(mergeABC, vA)).toBe("after");
    expect(clockA.compare(mergeABC, vB)).toBe("after");
    expect(clockA.compare(mergeABC, vC)).toBe("after");
  });

  it("mergeVersions never returns concurrent with its inputs", () => {
    const merged = clockA.mergeVersions!(vA, vB);
    expect(clockA.compare(merged, vA)).not.toBe("concurrent");
    expect(clockA.compare(merged, vB)).not.toBe("concurrent");
  });
});
