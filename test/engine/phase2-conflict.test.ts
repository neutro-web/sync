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

// ---------------------------------------------------------------------------
// Q2 — Model C: conflict detected and held; apply() stays synchronous
// ---------------------------------------------------------------------------

describe("Q2 · Model C: concurrent conflict detected, held, apply() synchronous", () => {
  it("concurrent writes open a conflict; apply() returns synchronously; cursor does not advance", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q2-doc");
    const engine = new Engine(new VectorClockStrategy("engine"));

    // Land confirmed state via A's version.
    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    const cursorAfterFirst = engine.getCursor(scope);
    expect(cursorAfterFirst._seq).toBe(1);

    // Apply causally-independent version from B — must be concurrent.
    const vB = clockB.mint(); // no knowledge of vA → concurrent

    let conflictFired = false;
    engine.subscribe(scope, {
      onBatch: () => {},
      onConflict: () => {
        conflictFired = true;
        return { decision: "defer" };
      },
    });

    // apply() fires onConflict synchronously during the call — no microtask needed.
    // If conflictFired is true BEFORE await, the notification happened inline.
    const p = engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));
    expect(conflictFired).toBe(true); // fires synchronously inside apply(), before any yield
    await p;
    // Cursor must NOT have advanced — concurrent change does not confirm.
    expect(engine.getCursor(scope)._seq).toBe(1);
  });

  it("snapshot() shows last-confirmed value immediately after conflict detection", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q2-snap");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    const state = await getState(engine, scope);
    // last-confirmed-winner: concurrent incoming must NOT overwrite confirmed state.
    expect(state.get("u1")).toBe("confirmed-val");
  });
});

// ---------------------------------------------------------------------------
// Q5 — defer leaves conflict open
// ---------------------------------------------------------------------------

describe("Q5 · defer: conflict stays open, state unchanged, subsequent resolution lands", () => {
  it("resolver returning defer keeps last-confirmed; subsequent take-remote lands correctly", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q5-doc");
    const unit = makeConflictUnit("u1");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    // Confirmed state unchanged after conflict detected.
    expect((await getState(engine, scope)).get("u1")).toBe("confirmed-val");

    // Call resolveConflict with defer — must leave conflict open.
    engine.resolveConflict(scope, unit, { decision: "defer" });
    expect((await getState(engine, scope)).get("u1")).toBe("confirmed-val");

    // Resolve with take-remote — concurrent-val should now land.
    engine.resolveConflict(scope, unit, { decision: "take-remote" });
    expect((await getState(engine, scope)).get("u1")).toBe("concurrent-val");
  });

  it("resolveConflict on a unit with no open conflict is a no-op and does not throw", () => {
    const engine = new Engine(new VectorClockStrategy("engine"));
    expect(() =>
      engine.resolveConflict(
        makeScope("no-conflict"),
        makeConflictUnit("u1"),
        { decision: "take-local" },
      ),
    ).not.toThrow();
  });

  it("resolveConflict with decision 'merged' throws before any state mutation", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const engine = new Engine(clockA);
    const scope = makeScope("merged-throw");
    const vA = clockA.mint();
    const vB = clockB.mint();
    engine.subscribe(scope, { onBatch: () => {}, onConflict: () => ({ decision: "defer" }) });
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    await engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));
    expect(() =>
      engine.resolveConflict(scope, makeConflictUnit("u1"), { decision: "merged" } as any)
    ).toThrow("resolveConflict: 'merged' is not supported in Phase 2");
  });

  it("take-remote resolves an ephemeral conflict and does not advance the cursor", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const engine = new Engine(clockA);
    const scope = makeScope("ephemeral-conflict");
    const vA = clockA.mint();
    const vB = clockB.mint();
    engine.subscribe(scope, { onBatch: () => {}, onConflict: () => ({ decision: "defer" }) });
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId("id-A"), kind: "state", scope, unit: makeConflictUnit("u1"),
        value: "val-A", version: vA, lifetime: { class: "ephemeral" },
      } as any],
    });
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId("id-B"), kind: "state", scope, unit: makeConflictUnit("u1"),
        value: "val-B", version: vB, lifetime: { class: "ephemeral" },
      } as any],
    });
    engine.resolveConflict(scope, makeConflictUnit("u1"), { decision: "take-remote" });
    const snap = await engine.snapshot(scope);
    expect(snap.changes.find((c) => c.unit.key === "u1")?.value).toBe("val-B");
    expect(engine.getCursor(scope)._seq).toBe(0);
  });

  it("calling resolveConflict twice for the same unit is a no-op on the second call", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const engine = new Engine(clockA);
    const scope = makeScope("double-resolve");
    const vA = clockA.mint();
    const vB = clockB.mint();
    engine.subscribe(scope, { onBatch: () => {}, onConflict: () => ({ decision: "defer" }) });
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    await engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));
    engine.resolveConflict(scope, makeConflictUnit("u1"), { decision: "take-remote" });
    expect(() =>
      engine.resolveConflict(scope, makeConflictUnit("u1"), { decision: "take-local" })
    ).not.toThrow();
    const snap = await engine.snapshot(scope);
    expect(snap.changes.find((c) => c.unit.key === "u1")?.value).toBe("val-B");
  });
});

// ---------------------------------------------------------------------------
// Q3 — Resolver wiring is live (closes Phase 1b Finding #3)
// ---------------------------------------------------------------------------

describe("Q3 · ResolverPump: resolver IS invoked on a concurrent conflict", () => {
  it("recording resolver is called exactly once with the correct conflict payload", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q3-doc");
    const unit = makeConflictUnit("u1");

    const capturedConflicts: Conflict[] = [];
    const recordingResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        capturedConflicts.push(conflict);
        return { decision: "take-local" };
      },
    };

    const engine = new Engine(new VectorClockStrategy("engine"));
    new ResolverPump(engine, recordingResolver, scope);

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));

    const vB = clockB.mint(); // concurrent — no knowledge of vA
    await engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));

    // Resolver must have been called exactly once.
    expect(capturedConflicts).toHaveLength(1);
    expect(capturedConflicts[0]!.unit.key).toBe(unit.key);
    expect(capturedConflicts[0]!.scope.key).toBe(scope.key);
    // local = confirmed state (val-A); remote = incoming concurrent (val-B)
    expect(capturedConflicts[0]!.local.value).toBe("val-A");
    expect(capturedConflicts[0]!.remote.value).toBe("val-B");
  });

  it("async resolver rejection logs error and leaves conflict open", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const engine = new Engine(clockA);
    const scope = makeScope("async-reject");
    const vA = clockA.mint();
    const vB = clockB.mint();
    engine.subscribe(scope, { onBatch: () => {}, onConflict: () => ({ decision: "defer" }) });
    const rejectingResolver: Resolver = {
      resolve: () => Promise.reject(new Error("async resolver boom")),
    };
    const pump = new ResolverPump(engine, rejectingResolver, scope);
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    await engine.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    await engine.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));
    await new Promise((r) => setTimeout(r, 0));
    console.error = origError;
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0])).toContain("[ResolverPump] async resolution failed");
    const snap = await engine.snapshot(scope);
    expect(snap.changes.find((c) => c.unit.key === "u1")?.value).toBe("val-A");
    pump.dispose();
  });
});

// ---------------------------------------------------------------------------
// Q6 — last-confirmed-winner reads during open conflict
// ---------------------------------------------------------------------------

describe("Q6 · last-confirmed-winner reads during open conflict", () => {
  it("snapshot() returns confirmed value; changes() excludes concurrent incoming", async () => {
    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q6-doc");
    const engine = new Engine(new VectorClockStrategy("engine"));

    const vA = clockA.mint();
    await engine.apply(makeStateBatch(scope, "u1", "confirmed-val", "id-A", vA));

    const vB = clockB.mint();
    await engine.apply(makeStateBatch(scope, "u1", "concurrent-val", "id-B", vB));

    // snapshot: confirmed only.
    const state = await getState(engine, scope);
    expect(state.get("u1")).toBe("confirmed-val");

    // changes(): concurrent incoming must not appear in the durable log.
    const logIds = new Set<string>();
    for await (const batch of engine.changes(scope, null)) {
      for (const c of batch.changes) logIds.add(c.id.value);
    }
    expect(logIds.has("id-A")).toBe(true);  // confirmed change is in log
    expect(logIds.has("id-B")).toBe(false); // concurrent incoming is NOT in log
  });
});

// ---------------------------------------------------------------------------
// Q4 — Resolution converges on ≥2 replicas (headline gate)
// ---------------------------------------------------------------------------

describe("Q4 · Convergence: deterministic resolver produces same result on both replicas", () => {
  it("two replicas independently resolve the same conflict to the same value under fault injection", async () => {
    // Convergence mechanism: approach (a) — deterministic pure function of the
    // conflict. Picks the change with the lexicographically-larger id.value.
    // Symmetric: same winner regardless of which side is "local" vs "remote".
    const deterministicResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        return conflict.local.id.value > conflict.remote.id.value
          ? { decision: "take-local" }
          : { decision: "take-remote" };
      },
    };

    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q4-doc");

    // Two engines; each uses its own VectorClockStrategy so their minted versions
    // have no causal relationship (concurrent by construction).
    const engineA = new Engine(new VectorClockStrategy("engine-A"));
    const engineB = new Engine(new VectorClockStrategy("engine-B"));

    // Attach ResolverPumps BEFORE applying local writes so they are subscribed
    // when onConflict fires.
    new ResolverPump(engineA, deterministicResolver, scope);
    new ResolverPump(engineB, deterministicResolver, scope);

    // Wire gossip (with fault injection).
    const { allChannels, throwIfErrors } = setupGossip(
      [engineA, engineB],
      scope,
      400,
      { dropRate: 0.2, reorderRate: 0.2, duplicateRate: 0.1 },
    );

    // Both replicas write to the same unit WITHOUT exchanging first.
    // "id-A" < "id-B" lexicographically → B's value is the expected winner.
    const vA = clockA.mint();
    const vB = clockB.mint(); // no knowledge of vA → concurrent
    await engineA.apply(makeStateBatch(scope, "u1", "val-A", "id-A", vA));
    await engineB.apply(makeStateBatch(scope, "u1", "val-B", "id-B", vB));

    await drainChannels(allChannels);
    throwIfErrors();

    const stateA = await getState(engineA, scope);
    const stateB = await getState(engineB, scope);

    // Both replicas must agree — the deterministic resolver picked the same winner.
    expect(stateA.get("u1")).toBe(stateB.get("u1"));
    // "id-B" > "id-A" → "val-B" is the winner on both replicas.
    expect(stateA.get("u1")).toBe("val-B");
  });

  it("convergence holds across multiple units with independent concurrent conflicts", async () => {
    const deterministicResolver: Resolver = {
      resolve(conflict: Conflict): Resolution {
        return conflict.local.id.value > conflict.remote.id.value
          ? { decision: "take-local" }
          : { decision: "take-remote" };
      },
    };

    const clockA = new VectorClockStrategy("A");
    const clockB = new VectorClockStrategy("B");
    const scope = makeScope("q4-multi");

    const engineA = new Engine(new VectorClockStrategy("engine-A"));
    const engineB = new Engine(new VectorClockStrategy("engine-B"));

    new ResolverPump(engineA, deterministicResolver, scope);
    new ResolverPump(engineB, deterministicResolver, scope);

    const { allChannels, throwIfErrors } = setupGossip([engineA, engineB], scope, 410);

    // Concurrent writes to two different units.
    // u1: "id-u1-A" < "id-u1-B" → val-B wins
    // u2: "id-u2-A" < "id-u2-B" → val-B wins
    await engineA.apply(makeStateBatch(scope, "u1", "u1-val-A", "id-u1-A", clockA.mint()));
    await engineA.apply(makeStateBatch(scope, "u2", "u2-val-A", "id-u2-A", clockA.mint()));
    await engineB.apply(makeStateBatch(scope, "u1", "u1-val-B", "id-u1-B", clockB.mint()));
    await engineB.apply(makeStateBatch(scope, "u2", "u2-val-B", "id-u2-B", clockB.mint()));

    await drainChannels(allChannels);
    throwIfErrors();

    const stateA = await getState(engineA, scope);
    const stateB = await getState(engineB, scope);

    expect(stateA.get("u1")).toBe(stateB.get("u1"));
    expect(stateA.get("u2")).toBe(stateB.get("u2"));
    expect(stateA.get("u1")).toBe("u1-val-B");
    expect(stateA.get("u2")).toBe("u2-val-B");
  });
});
