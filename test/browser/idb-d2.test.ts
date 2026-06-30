/**
 * D2 — T3 on real IndexedDB: durable persisted, ephemeral never written.
 * Gate: docs/gates/phase3-persistence.md § D2.
 *
 * Isolation: each test uses a unique DB name so tests don't share state.
 * The leading clear() at test start removes any leftover from prior runs.
 */
import { describe, it, expect } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { IndexedDBStore } from "../../src/persistence/idb-store.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";
import {
  makeChangeId, makeScope, makeConflictUnit, DURABLE, ephemeral,
} from "../../src/core/types.ts";

const clock = new LWWClockStrategy(0);

describe("D2 — T3 on real IndexedDB", () => {
  it("D2 — durable state change is present in the IndexedDB store after apply()", async () => {
    const DB = "ns-test-d2-t1";
    // Clear any leftover from a prior run before opening the real store.
    await new IndexedDBStore(DB).clear();
    const store = new IndexedDBStore(DB);
    const scope = makeScope("s-d2-t1");
    const engine = new Engine(clock, { store });
    await engine.hydrateScope(scope);
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId("d2-durable"),
        kind: "state",
        scope,
        unit: makeConflictUnit("u1"),
        lifetime: DURABLE,
        value: "durable-val",
        version: clock.mint(),
      }],
    });
    // Fire-and-forget writes are async — wait for the IDB flush.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await store.readChanges(scope.key);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.change as any).value).toBe("durable-val");
  });

  it("D2 — ephemeral state change produces ZERO records in IndexedDB (T3)", async () => {
    const DB = "ns-test-d2-t2";
    await new IndexedDBStore(DB).clear();
    const store = new IndexedDBStore(DB);
    const scope = makeScope("s-d2-t2");
    const engine = new Engine(clock, { store });
    await engine.hydrateScope(scope);
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId("d2-ephemeral"),
        kind: "state",
        scope,
        unit: makeConflictUnit("u2"),
        lifetime: ephemeral(5000),
        value: "ephemeral-val",
        version: clock.mint(),
      }],
    });
    await new Promise((r) => setTimeout(r, 50));
    // Must be zero — an ephemeral write must not touch the store.
    const rows = await store.readChanges(scope.key);
    expect(rows).toHaveLength(0);
  });

  it("D2 — cursor record is written for durable, absent for ephemeral-only scope", async () => {
    const DB = "ns-test-d2-t3";
    await new IndexedDBStore(DB).clear();
    const store = new IndexedDBStore(DB);
    const scope = makeScope("s-d2-t3");
    const engine = new Engine(clock, { store });
    await engine.hydrateScope(scope);
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId("d2-cursor"),
        kind: "state",
        scope,
        unit: makeConflictUnit("u3"),
        lifetime: DURABLE,
        value: "v",
        version: clock.mint(),
      }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const cursor = await store.readCursor(scope.key);
    expect(cursor).toBe(1);

    // Ephemeral-only scope: cursor must not advance
    const scope2 = makeScope("s-d2-t3-eph");
    await engine.hydrateScope(scope2);
    await engine.apply({
      scope: scope2,
      changes: [{
        id: makeChangeId("d2-eph-only"),
        kind: "state",
        scope: scope2,
        unit: makeConflictUnit("u4"),
        lifetime: ephemeral(5000),
        value: "eph",
        version: clock.mint(),
      }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.readCursor(scope2.key)).toBeNull();
  });
});
