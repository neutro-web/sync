/**
 * Phase 1b engine tests — gate items P2–P5.
 *
 * P1 (existing 10 harness tests pass, harness unmodified) is satisfied by the
 * full `pnpm test` run; the harness tests are in test/harness/harness.test.ts
 * and are untouched.
 *
 * Gossip wiring
 * -------------
 * The real Engine does not have an `onForward` callback (that was a harness-only
 * seam on the stubs). Instead, tests wire gossip through `ScopeRouter.subscribe()`:
 * each engine subscribes to the test scope; in `onBatch`, it enqueues the batch
 * into the directed channel toward each peer. The channel delivers asynchronously
 * via `drainChannels()`.
 *
 * This uses the production API (`Feed` + `ScopeRouter`), not harness internals.
 */

import { describe, it, expect } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";
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
  Resolver,
  Conflict,
  Resolution,
} from "../../src/core/types.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain all channels to quiescence (same round-based pattern as ConvergenceHarness). */
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

/**
 * Get the current value per unit for a scope from an engine's snapshot.
 * Returns a Map<unitKey, value>.
 */
async function getState(
  engine: Engine,
  scope: Scope,
): Promise<Map<string, unknown>> {
  const snap = await engine.snapshot(scope);
  const state = new Map<string, unknown>();
  for (const c of snap.changes) {
    state.set(c.unit.key, c.value);
  }
  return state;
}

/**
 * Wire N-replica gossip through directed ChannelSimulators.
 * Each engine subscribes to `scope`; on `onBatch`, enqueues to channels toward
 * all other engines. Channel keys: "i→j". Seeds: baseSeed + i*100 + j.
 */
function setupGossip(
  engines: Engine[],
  scope: Scope,
  baseSeed: number,
  faultConfig?: FaultConfig,
): { channels: Map<string, ChannelSimulator>; allChannels: ChannelSimulator[] } {
  const n = engines.length;
  const channels = new Map<string, ChannelSimulator>();

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
    const capturedI = i;
    engines[i]!.subscribe(scope, {
      onBatch: (batch) => {
        for (let j = 0; j < n; j++) {
          if (j === capturedI) continue;
          const ch = channels.get(`${capturedI}→${j}`)!;
          ch.enqueue(batch, (b) => {
            void engines[j]!.apply(b);
          });
        }
      },
      onConflict: () => ({ decision: "defer" }),
    });
  }

  return { channels, allChannels: Array.from(channels.values()) };
}

/** Make a durable state ChangeBatch for a single change. */
function makeStateBatch(
  scope: Scope,
  unitKey: string,
  value: unknown,
  idSuffix: string,
  version: import("../../src/core/types.ts").Version,
): ChangeBatch {
  return {
    scope,
    changes: [
      {
        id: makeChangeId(`c-${unitKey}-${idSuffix}`),
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

/** Make a durable op ChangeBatch (no version — pure intent). */
function makeOpBatch(
  scope: Scope,
  unitKey: string,
  value: unknown,
  id: string,
): ChangeBatch {
  return {
    scope,
    changes: [
      {
        id: makeChangeId(id),
        scope,
        unit: makeConflictUnit(unitKey),
        kind: "op",
        lifetime: DURABLE,
        value,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// P2 — LWW contention
// ---------------------------------------------------------------------------

describe("P2 · LWW contention: higher version wins everywhere", () => {
  it("two replicas write the same unit; after drain the higher version wins on both", async () => {
    const clock = new LWWClockStrategy();
    const scope = makeScope("doc-1");

    const engine0 = new Engine(new LWWClockStrategy());
    const engine1 = new Engine(new LWWClockStrategy());

    const { allChannels } = setupGossip(
      [engine0, engine1],
      scope,
      200,
      { dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 },
    );

    // Deterministic version ordering: v_low < v_high.
    const v_low = clock.mint();  // _ts=1
    const v_high = clock.mint(); // _ts=2

    // Both replicas write to the same unit BEFORE any drain (true concurrency).
    await engine0.apply(makeStateBatch(scope, "u1", "from-R0-low", "r0", v_low));
    await engine1.apply(makeStateBatch(scope, "u1", "from-R1-high", "r1", v_high));

    await drainChannels(allChannels);

    const state0 = await getState(engine0, scope);
    const state1 = await getState(engine1, scope);

    expect(state0.get("u1")).toBe("from-R1-high");
    expect(state1.get("u1")).toBe("from-R1-high");
  });

  it("convergence holds under repeated concurrent writes (3 rounds of contention)", async () => {
    const clock = new LWWClockStrategy();
    const scope = makeScope("doc-2");

    const engine0 = new Engine(new LWWClockStrategy());
    const engine1 = new Engine(new LWWClockStrategy());

    const { allChannels } = setupGossip([engine0, engine1], scope, 210);

    for (let round = 0; round < 3; round++) {
      const v_low  = clock.mint();
      const v_high = clock.mint();
      await engine0.apply(makeStateBatch(scope, "u1", `low-round-${round}`, `r0-${round}`, v_low));
      await engine1.apply(makeStateBatch(scope, "u1", `high-round-${round}`, `r1-${round}`, v_high));
      await drainChannels(allChannels);
    }

    const state0 = await getState(engine0, scope);
    const state1 = await getState(engine1, scope);
    expect(state0.get("u1")).toBe(state1.get("u1"));
    expect((state0.get("u1") as string).startsWith("high-")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P3 — Op dedup
// ---------------------------------------------------------------------------

describe("P3 · Op dedup: duplicate-delivered op applies exactly once", () => {
  it("same op id delivered twice to a replica is applied once", async () => {
    const scope = makeScope("doc-3");
    const engine0 = new Engine(new LWWClockStrategy());
    const engine1 = new Engine(new LWWClockStrategy());

    // duplicateRate: 1.0 → every batch is duplicated in the channel.
    const { allChannels } = setupGossip(
      [engine0, engine1],
      scope,
      300,
      { duplicateRate: 1.0 },
    );

    const opBatch = makeOpBatch(scope, "cmd", "do-something", "op-abc-123");
    await engine0.apply(opBatch);
    await drainChannels(allChannels);

    // Check via changes() that the op appears exactly once in the durable log.
    let opCount = 0;
    for await (const batch of engine1.changes(scope, null)) {
      for (const c of batch.changes) {
        if (c.id.value === "op-abc-123") opCount++;
      }
    }
    expect(opCount).toBe(1);
  });

  it("op arriving at originating replica via gossip loop is also deduped", async () => {
    const scope = makeScope("doc-3b");
    const engine0 = new Engine(new LWWClockStrategy());
    const engine1 = new Engine(new LWWClockStrategy());

    const { allChannels } = setupGossip([engine0, engine1], scope, 310);

    const opBatch = makeOpBatch(scope, "cmd", "ping", "op-ping-1");
    await engine0.apply(opBatch);
    await drainChannels(allChannels);

    // engine0 should have the op in its durable log exactly once,
    // even though engine1 gossiped it back.
    let opCount = 0;
    for await (const batch of engine0.changes(scope, null)) {
      for (const c of batch.changes) {
        if (c.id.value === "op-ping-1") opCount++;
      }
    }
    expect(opCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P4 — T3: ephemeral is off the durable path
// ---------------------------------------------------------------------------

describe("P4 · T3: ephemeral changes are off the durable path", () => {
  it("P4a: cursor does not advance on ephemeral changes", async () => {
    const scope = makeScope("doc-4");
    const engine = new Engine(new LWWClockStrategy());
    const clock = new LWWClockStrategy();

    // Apply one durable state change — cursor should advance to 1.
    await engine.apply(makeStateBatch(scope, "u1", "durable-val", "d1", clock.mint()));
    expect(engine.getCursor(scope)._seq).toBe(1);

    // Apply one ephemeral state change — cursor must NOT advance.
    await engine.apply({
      scope,
      changes: [
        {
          id: makeChangeId("eph-1"),
          scope,
          unit: makeConflictUnit("u2"),
          kind: "state",
          lifetime: ephemeral(5000),
          value: "ephemeral-val",
          version: clock.mint(),
        },
      ],
    });
    expect(engine.getCursor(scope)._seq).toBe(1); // still 1
  });

  it("P4b: ephemeral changes do not appear in changes() replay", async () => {
    const scope = makeScope("doc-4b");
    const engine = new Engine(new LWWClockStrategy());
    const clock = new LWWClockStrategy();

    await engine.apply(makeStateBatch(scope, "u1", "durable-val", "d1", clock.mint()));
    await engine.apply({
      scope,
      changes: [
        {
          id: makeChangeId("eph-2"),
          scope,
          unit: makeConflictUnit("u2"),
          kind: "state",
          lifetime: ephemeral(5000),
          value: "ephemeral-val",
          version: clock.mint(),
        },
      ],
    });

    const replayedIds = new Set<string>();
    for await (const batch of engine.changes(scope, null)) {
      for (const c of batch.changes) replayedIds.add(c.id.value);
    }

    // makeStateBatch generates id = `c-${unitKey}-${idSuffix}` = "c-u1-d1"
    expect(replayedIds.has("c-u1-d1")).toBe(true);  // durable: replayed ✓
    expect(replayedIds.has("eph-2")).toBe(false);   // ephemeral: NOT replayed ✓
  });

  it("P4c: ephemeral changes appear in snapshot() (they are current state)", async () => {
    const scope = makeScope("doc-4c");
    const engine = new Engine(new LWWClockStrategy());
    const clock = new LWWClockStrategy();

    await engine.apply(makeStateBatch(scope, "u1", "durable-val", "d1", clock.mint()));
    await engine.apply({
      scope,
      changes: [
        {
          id: makeChangeId("eph-3"),
          scope,
          unit: makeConflictUnit("u2"),
          kind: "state",
          lifetime: ephemeral(5000),
          value: "ephemeral-val",
          version: clock.mint(),
        },
      ],
    });

    const state = await getState(engine, scope);
    expect(state.get("u1")).toBe("durable-val");       // durable in snapshot ✓
    expect(state.get("u2")).toBe("ephemeral-val");     // ephemeral in snapshot ✓
  });
});

// ---------------------------------------------------------------------------
// P8 — Reconnect replay: missed changes recovered via changes(since)
// ---------------------------------------------------------------------------

describe("P8 · Reconnect replay: missed changes recovered via changes(since)", () => {
  it("replica B catches up via changes(scope, cursor) after missing writes during partition", async () => {
    const clock = new LWWClockStrategy();
    const scope = makeScope("doc-8");

    const engineA = new Engine(new LWWClockStrategy());
    const engineB = new Engine(new LWWClockStrategy());

    // A applies three durable state changes; B receives none (simulates partition).
    const v1 = clock.mint();
    const v2 = clock.mint();
    const v3 = clock.mint();
    await engineA.apply(makeStateBatch(scope, "x", "x-val", "a1", v1));
    await engineA.apply(makeStateBatch(scope, "y", "y-val", "a2", v2));
    await engineA.apply(makeStateBatch(scope, "z", "z-val", "a3", v3));

    // B missed all writes — cursor is at seq 0.
    const cursorBefore = engineB.getCursor(scope);
    expect(cursorBefore._seq).toBe(0);

    // Reconnect: B requests all changes from A since its cursor.
    for await (const batch of engineA.changes(scope, cursorBefore)) {
      await engineB.apply(batch);
    }

    // After replay: B's snapshot matches A's for every unit.
    const stateA = await getState(engineA, scope);
    const stateB = await getState(engineB, scope);
    expect(stateB.get("x")).toBe(stateA.get("x"));
    expect(stateB.get("y")).toBe(stateA.get("y"));
    expect(stateB.get("z")).toBe(stateA.get("z"));

    // B's cursor advanced to A's terminal seq.
    expect(engineB.getCursor(scope)._seq).toBe(engineA.getCursor(scope)._seq);

    // T3 sanity: replay yielded only durable ids (changes() never includes ephemeral).
    const replayedIds = new Set<string>();
    for await (const batch of engineB.changes(scope, null)) {
      for (const c of batch.changes) replayedIds.add(c.id.value);
    }
    expect(replayedIds.has("c-x-a1")).toBe(true);
    expect(replayedIds.has("c-y-a2")).toBe(true);
    expect(replayedIds.has("c-z-a3")).toBe(true);
  });

  it("partial replay: changes(scope, cursor) yields only entries B missed", async () => {
    const clock = new LWWClockStrategy();
    const scope = makeScope("doc-8b");

    const engineA = new Engine(new LWWClockStrategy());
    const engineB = new Engine(new LWWClockStrategy());

    // B receives the first two changes before the partition.
    const v1 = clock.mint();
    const v2 = clock.mint();
    await engineA.apply(makeStateBatch(scope, "a", "a-val", "b1", v1));
    await engineB.apply(makeStateBatch(scope, "a", "a-val", "b1", v1));
    await engineA.apply(makeStateBatch(scope, "b", "b-val", "b2", v2));
    await engineB.apply(makeStateBatch(scope, "b", "b-val", "b2", v2));

    // B's cursor after two durable changes.
    const cursorB = engineB.getCursor(scope); // seq=2

    // A applies two more changes that B misses (partition).
    const v3 = clock.mint();
    const v4 = clock.mint();
    await engineA.apply(makeStateBatch(scope, "c", "c-val", "b3", v3));
    await engineA.apply(makeStateBatch(scope, "d", "d-val", "b4", v4));

    // Reconnect: B requests only what it missed (since cursorB, seq=2).
    for await (const batch of engineA.changes(scope, cursorB)) {
      await engineB.apply(batch);
    }

    // B now holds all 4 values.
    const stateB = await getState(engineB, scope);
    expect(stateB.get("a")).toBe("a-val");
    expect(stateB.get("b")).toBe("b-val");
    expect(stateB.get("c")).toBe("c-val");
    expect(stateB.get("d")).toBe("d-val");

    // B's durable log has exactly 4 entries — no double-counting of b1/b2.
    const replayedIds = new Set<string>();
    for await (const batch of engineB.changes(scope, null)) {
      for (const c of batch.changes) replayedIds.add(c.id.value);
    }
    expect(replayedIds.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// P9 — 3-replica contention under partition
// ---------------------------------------------------------------------------

describe("P9 · 3-replica contention under partition", () => {
  it("all 3 replicas converge on globally-highest version after partition/reconnect", async () => {
    const clock = new LWWClockStrategy();
    const scope = makeScope("doc-9");

    const engines = [
      new Engine(new LWWClockStrategy()),
      new Engine(new LWWClockStrategy()),
      new Engine(new LWWClockStrategy()),
    ];

    const { channels, allChannels } = setupGossip(engines, scope, 900);

    // Phase 1: all 3 write the same unit; highest version (v3) should win everywhere.
    const v1 = clock.mint(); // _ts=1
    const v2 = clock.mint(); // _ts=2
    const v3 = clock.mint(); // _ts=3
    await engines[0]!.apply(makeStateBatch(scope, "u1", "val-v1", "r0-p1", v1));
    await engines[1]!.apply(makeStateBatch(scope, "u1", "val-v2", "r1-p1", v2));
    await engines[2]!.apply(makeStateBatch(scope, "u1", "val-v3", "r2-p1", v3));
    await drainChannels(allChannels);

    for (const engine of engines) {
      expect((await getState(engine, scope)).get("u1")).toBe("val-v3");
    }

    // Phase 2: isolate replica 2 from all others.
    channels.get("0→2")!.partition();
    channels.get("1→2")!.partition();
    channels.get("2→0")!.partition();
    channels.get("2→1")!.partition();

    // Replica 2 writes a competing version while isolated (v_island, lower _ts).
    // Replicas 0 and 1 write a higher version (v_winner, higher _ts).
    const v_island = clock.mint(); // _ts=4
    const v_winner = clock.mint(); // _ts=5
    await engines[2]!.apply(makeStateBatch(scope, "u1", "val-island", "r2-island", v_island));
    await engines[0]!.apply(makeStateBatch(scope, "u1", "val-winner", "r0-winner", v_winner));

    // Drain only between replicas 0 and 1 (2 is cut off).
    await drainChannels([channels.get("0→1")!, channels.get("1→0")!]);

    // Verify pre-reconnect state: 0 and 1 on v_winner, 2 still on v_island.
    expect((await getState(engines[0]!, scope)).get("u1")).toBe("val-winner");
    expect((await getState(engines[1]!, scope)).get("u1")).toBe("val-winner");
    expect((await getState(engines[2]!, scope)).get("u1")).toBe("val-island");

    // Phase 3: reconnect replica 2 and drain to quiescence.
    channels.get("0→2")!.reconnect();
    channels.get("1→2")!.reconnect();
    channels.get("2→0")!.reconnect();
    channels.get("2→1")!.reconnect();
    await drainChannels(allChannels);

    // All 3 must converge on the globally-highest version (_ts=5, val-winner).
    for (const engine of engines) {
      expect((await getState(engine, scope)).get("u1")).toBe("val-winner");
    }
  });
});

// ---------------------------------------------------------------------------
// P5 — T4 (LWW path): take-by-version, Resolver never invoked
// ---------------------------------------------------------------------------

describe("P5 · LWW take-by-version: Resolver is never invoked", () => {
  it("state collision resolved by version; throwing Resolver confirms it is never called", async () => {
    const scope = makeScope("doc-5");
    const clock = new LWWClockStrategy();

    // Resolver that throws — any invocation means the engine incorrectly
    // routed to conflict resolution when a clear before/after existed.
    const throwingResolver: Resolver = {
      resolve(_conflict: Conflict): Resolution {
        throw new Error(
          "Resolver must not be called when compare() returns before/after",
        );
      },
    };

    const engine0 = new Engine(new LWWClockStrategy(), throwingResolver);
    const engine1 = new Engine(new LWWClockStrategy(), throwingResolver);

    const { allChannels } = setupGossip([engine0, engine1], scope, 500);

    const v_low  = clock.mint(); // _ts=1
    const v_high = clock.mint(); // _ts=2

    await engine0.apply(makeStateBatch(scope, "u1", "low-val", "r0", v_low));
    await engine1.apply(makeStateBatch(scope, "u1", "high-val", "r1", v_high));

    // Should not throw (Resolver not invoked).
    await expect(drainChannels(allChannels)).resolves.toBeUndefined();

    const state0 = await getState(engine0, scope);
    const state1 = await getState(engine1, scope);

    // Higher version wins on both replicas.
    expect(state0.get("u1")).toBe("high-val");
    expect(state1.get("u1")).toBe("high-val");
  });
});
