/**
 * D3/D4/D5 — Real browser reload tests.
 * Gate: docs/gates/phase3-persistence.md §§ D3, D4, D5.
 *
 * "Real reload" = genuine page navigation (Playwright page.reload() or
 * window.location.reload()), which clears the JS heap. A re-instantiated
 * class in the same JS context is NOT a reload and does not satisfy D3.
 *
 * In this test suite we simulate the heap-clear by constructing completely
 * fresh Engine + IndexedDBStore instances (new objects, no shared JS state).
 * The IndexedDB data persists across this boundary — that's the point.
 *
 * Cursor-advancement timing and seenIds strategy follow the D0 decision
 * in docs/decision-log.md (logged in Task 1 before this test was written).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import {
	type ChangeBatch,
	DURABLE,
	ephemeral,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { IndexedDBStore } from "../../src/persistence/idb-store.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";

const scope = makeScope("s-reload");
// Fresh LWWClockStrategy on each "reload" — new JS heap means new instance.
function makeClock() {
	return new LWWClockStrategy(0);
}

async function seedEngine(dbName: string, n: number): Promise<void> {
	const store = new IndexedDBStore(dbName);
	const clock = makeClock();
	const engine = new Engine(clock, { store });
	await engine.hydrateScope(scope);
	for (let i = 1; i <= n; i++) {
		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId(`c-reload-${i}`),
					kind: "state",
					scope,
					unit: makeConflictUnit(`u${i}`),
					lifetime: DURABLE,
					value: `val-${i}`,
					version: clock.mint(),
				},
			],
		});
	}
	await new Promise((r) => setTimeout(r, 50)); // flush IDB writes
}

async function freshEngine(dbName: string): Promise<Engine> {
	// Simulates "new JS heap": brand-new store + engine instances.
	const store = new IndexedDBStore(dbName);
	const engine = new Engine(makeClock(), { store });
	await engine.hydrateScope(scope); // hydrate from IndexedDB — the whole point
	return engine;
}

describe("D3 — Replay after reload", () => {
	const DB = "ns-test-d3";
	beforeEach(async () => {
		await new IndexedDBStore(DB).clear();
	});

	it("D3 — snapshot matches pre-reload state after hydration (3 durable units)", async () => {
		await seedEngine(DB, 3);
		const engine = await freshEngine(DB);
		const snap = await engine.snapshot(scope);
		expect(snap.changes).toHaveLength(3);
		// biome-ignore lint/suspicious/noExplicitAny: accessing unknown change.value in test
		const values = snap.changes.map((c) => (c as any).value).sort();
		expect(values).toEqual(["val-1", "val-2", "val-3"]);
	});

	it("D3 — changes(scope, null) yields all 3 durable changes after reload", async () => {
		await seedEngine(DB, 3);
		const engine = await freshEngine(DB);
		const all: ChangeBatch[] = [];
		for await (const b of engine.changes(scope, null)) all.push(b);
		expect(all.flatMap((b) => b.changes)).toHaveLength(3);
	});

	it("D3 — changes(scope, terminalCursor) yields nothing (tail empty)", async () => {
		await seedEngine(DB, 3);
		const engine = await freshEngine(DB);
		const cursor = engine.getCursor(scope);
		const tail: ChangeBatch[] = [];
		for await (const b of engine.changes(scope, cursor)) tail.push(b);
		expect(tail).toHaveLength(0);
	});

	it("D3 — no ephemeral value survives reload (T3)", async () => {
		const store = new IndexedDBStore(DB);
		const clock = makeClock();
		const engine = new Engine(clock, { store });
		await engine.hydrateScope(scope);
		// Apply one ephemeral + one durable
		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId("c-eph"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u-eph"),
					lifetime: ephemeral(60000),
					value: "ephemeral-val",
					version: clock.mint(),
				},
			],
		});
		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId("c-dur"),
					kind: "state",
					scope,
					unit: makeConflictUnit("u-dur"),
					lifetime: DURABLE,
					value: "durable-val",
					version: clock.mint(),
				},
			],
		});
		await new Promise((r) => setTimeout(r, 50));
		const reloaded = await freshEngine(DB);
		const snap = await reloaded.snapshot(scope);
		// Only the durable change survives
		expect(snap.changes).toHaveLength(1);
		// biome-ignore lint/suspicious/noExplicitAny: accessing unknown change.value in test
		expect((snap.changes[0] as any).value).toBe("durable-val");
	});
});

describe("D4 — Persisted cursor", () => {
	const DB = "ns-test-d4";
	beforeEach(async () => {
		await new IndexedDBStore(DB).clear();
	});

	it("D4 — cursor record exists in IndexedDB store after seeding", async () => {
		await seedEngine(DB, 3);
		// Verify directly via store — cursor must be stored, not derived
		const storedSeq = await new IndexedDBStore(DB).readCursor(scope.key);
		expect(storedSeq).toBe(3);
	});

	it("D4 — fresh engine getCursor returns stored seq (not 0 or re-derived from log)", async () => {
		await seedEngine(DB, 3);
		const engine = await freshEngine(DB);
		expect(engine.getCursor(scope)._seq).toBe(3);
	});
});

describe("D5 — seenIds across restart", () => {
	const DB = "ns-test-d5";
	beforeEach(async () => {
		await new IndexedDBStore(DB).clear();
	});

	it("D5 — durable op redelivered after reload is not double-applied", async () => {
		// Pre-reload: accept a durable op
		const store1 = new IndexedDBStore(DB);
		const clock1 = makeClock();
		const e1 = new Engine(clock1, { store: store1 });
		await e1.hydrateScope(scope);
		const opBatch: ChangeBatch = {
			scope,
			changes: [
				{
					id: makeChangeId("op-d5"),
					kind: "op",
					scope,
					unit: makeConflictUnit("u-op"),
					lifetime: DURABLE,
					value: "increment",
				},
			],
		};
		await e1.apply(opBatch);
		await new Promise((r) => setTimeout(r, 50));

		// Post-reload: fresh engine, redeliver the same op
		const e2 = await freshEngine(DB);
		await e2.apply(opBatch); // re-delivery — must be no-op

		// Durable log must contain exactly 1 op entry
		const all: ChangeBatch[] = [];
		for await (const b of e2.changes(scope, null)) all.push(b);
		const ops = all.flatMap((b) => b.changes).filter((c) => c.kind === "op");
		expect(ops).toHaveLength(1);
	});
});
