/**
 * D7 — Persistence baseline numbers. CC/CI only.
 *
 * MEASUREMENT SEMANTICS (required by AGENTS.md and gate D7):
 * - "durable write latency": time from engine.apply() call entry to the fire-and-forget
 *   IDB write queued (not awaited). Measured as the per-call cost of apply() itself,
 *   NOT including IDB flush. Use a separate timed region that awaits the store directly
 *   for the IDB round-trip number.
 * - "replay throughput": time for hydrateScope() to complete, measured from just before
 *   the call to just after it resolves. Denominator: number of change records restored.
 * - "reload-to-ready": time from `new IndexedDBStore(name)` construction to
 *   hydrateScope() resolution. "Ready" = hydrateScope() has resolved and getCursor()
 *   returns the correct seq.
 *
 * SANDBOX NUMBERS ARE INVALID — only Playwright/Chromium (CC/CI) numbers are meaningful.
 * Record the console output in docs/decision-log.md after each CC run.
 */
import { bench, describe } from "vitest";
import { Engine } from "../src/core/engine.ts";
import { IndexedDBStore } from "../src/persistence/idb-store.ts";
import { LWWClockStrategy } from "../src/strategies/lww.ts";
import { makeChangeId, makeScope, makeConflictUnit, DURABLE } from "../src/core/types.ts";

const scope = makeScope("s-bench");
const DB_WRITE = "ns-bench-write";
const DB_REPLAY = "ns-bench-replay";

async function seedStore(dbName: string, n: number): Promise<void> {
  const store = new IndexedDBStore(dbName);
  await store.clear();
  const clock = new LWWClockStrategy(0);
  const engine = new Engine(clock, { store });
  await engine.hydrateScope(scope);
  for (let i = 1; i <= n; i++) {
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId(`bench-${i}`),
        kind: "state",
        scope,
        unit: makeConflictUnit(`u${i}`),
        lifetime: DURABLE,
        value: `v${i}`,
        version: clock.mint(),
      }],
    });
  }
  // Flush IDB writes before timing begins
  await new Promise((r) => setTimeout(r, 100));
}

describe("D7 — Persistence baseline (CC/CI only)", () => {
  bench("durable write latency — apply() call with IDB store (per write, N=1)", async () => {
    const store = new IndexedDBStore(DB_WRITE);
    const clock = new LWWClockStrategy(0);
    const engine = new Engine(clock, { store });
    await engine.hydrateScope(scope);
    await engine.apply({
      scope,
      changes: [{
        id: makeChangeId(`bench-w-${Date.now()}`),
        kind: "state",
        scope,
        unit: makeConflictUnit("u1"),
        lifetime: DURABLE,
        value: "v",
        version: clock.mint(),
      }],
    });
    // Await one microtask tick — fire-and-forget write is now queued
    await Promise.resolve();
  });

  bench("replay throughput — hydrateScope() for 1000 records", async () => {
    const store = new IndexedDBStore(DB_REPLAY);
    const engine = new Engine(new LWWClockStrategy(0), { store });
    // Timed region: hydrateScope only
    await engine.hydrateScope(scope);
  }, { setup: async () => { await seedStore(DB_REPLAY, 1000); } });

  bench("reload-to-ready — store open + hydrateScope() for 1000 records", async () => {
    const store = new IndexedDBStore(DB_REPLAY); // new instance = simulated reload
    const engine = new Engine(new LWWClockStrategy(0), { store });
    await engine.hydrateScope(scope);
  }, { setup: async () => { await seedStore(DB_REPLAY, 1000); } });
});
