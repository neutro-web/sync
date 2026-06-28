/**
 * Phase 2 gate tests — Q1-Q7.
 * Design basis: docs/design/conflict-resolution.md (Model C + last-confirmed-winner).
 */

import { describe, it, expect } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import {
  makeChangeId,
  makeScope,
  makeConflictUnit,
  DURABLE,
} from "../../src/core/types.ts";
import type {
  ChangeBatch,
  Scope,
  Resolver,
  Conflict,
  Resolution,
  Version,
} from "../../src/core/types.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drainChannels(
  channels: ChannelSimulator[],
  maxRounds = 100,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    let delivered = 0;
    for (const ch of channels) delivered += ch.drain();
    await Promise.resolve();
    if (delivered === 0) return;
  }
  throw new Error(`drainChannels: did not quiesce after ${maxRounds} rounds`);
}

async function getState(
  engine: Engine,
  scope: Scope,
): Promise<Map<string, unknown>> {
  const snap = await engine.snapshot(scope);
  const state = new Map<string, unknown>();
  for (const c of snap.changes) state.set(c.unit.key, c.value);
  return state;
}

/** Make a durable StateChange batch for a single unit. */
function makeStateBatch(
  scope: Scope,
  unitKey: string,
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
        unit: makeConflictUnit(unitKey),
        kind: "state",
        lifetime: DURABLE,
        value,
        version,
      },
    ],
  };
}

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
      channels.set(`${i}→${j}`, new ChannelSimulator(baseSeed + i * 100 + j, faultConfig));
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
      // Return value ignored by engine (Model C); pump drives resolution if wired.
      onConflict: () => ({ decision: "defer" }),
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

// ---------------------------------------------------------------------------
// Q1 — VectorClockStrategy produces "concurrent"
// ---------------------------------------------------------------------------

describe("Q1 · VectorClock: causally-independent versions compare as concurrent", () => {
  it("two nodes mint versions without knowledge of each other → concurrent both ways", () => {
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");

    const vA = clockA.mint(); // { _vec: { "node-A": 1 } }
    const vB = clockB.mint(); // { _vec: { "node-B": 1 } }

    expect(clockA.compare(vA, vB)).toBe("concurrent");
    expect(clockA.compare(vB, vA)).toBe("concurrent");
  });

  it("version minted after observing another is causally later (after, not concurrent)", () => {
    const clockA = new VectorClockStrategy("node-A");
    const clockB = new VectorClockStrategy("node-B");

    const vA = clockA.mint();    // { "node-A": 1 }
    const vB = clockB.mint(vA); // { "node-A": 1, "node-B": 1 } — knows about vA

    expect(clockA.compare(vB, vA)).toBe("after");
    expect(clockA.compare(vA, vB)).toBe("before");
  });

  it("identical versions compare as before (idempotent re-apply)", () => {
    const clock = new VectorClockStrategy("node-A");
    const v = clock.mint();
    expect(clock.compare(v, v)).toBe("before");
  });

  it("C minted after merging A and B is after both; A and B are concurrent", () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const clockC = new VectorClockStrategy("C");

    const vA = clockA.mint(); // { A: 1 }
    const vB = clockB.mint(); // { B: 1 }
    // A mints after seeing B: { B: 1, A: 2 }. C then mints after seeing A's merged
    // vector: { B: 1, A: 2, C: 1 }. C is causally after both A and B; A and B are
    // concurrent with each other.
    const vAseenB = clockA.mint(vB); // { B: 1, A: 2 }
    const vC = clockC.mint(vAseenB); // { B: 1, A: 2, C: 1 }

    expect(clockA.compare(vA, vB)).toBe("concurrent");
    expect(clockA.compare(vC, vA)).toBe("after");
    expect(clockA.compare(vC, vB)).toBe("after");
  });
});
