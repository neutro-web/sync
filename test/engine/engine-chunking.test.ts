import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import {
	type ChangeBatch,
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";

const scope = makeScope("s-chunk");
const clock = new LWWClockStrategy(0);

async function buildEngine(n: number, chunkSize: number): Promise<Engine> {
	const engine = new Engine(clock, { chunkSize });
	for (let i = 1; i <= n; i++) {
		await engine.apply({
			scope,
			changes: [
				{
					id: makeChangeId(`c-chunk-${i}`),
					kind: "state",
					scope,
					unit: makeConflictUnit(`u${i}`),
					lifetime: DURABLE,
					value: `v${i}`,
					version: clock.mint(),
				},
			],
		});
	}
	return engine;
}

describe("D6 — changes() chunking", () => {
	it("D6 — 250 changes with chunkSize=100 yields ≥3 batches, each ≤100 changes", async () => {
		const engine = await buildEngine(250, 100);
		const batches: ChangeBatch[] = [];
		for await (const b of engine.changes(scope, null)) batches.push(b);
		expect(batches.length).toBeGreaterThanOrEqual(3);
		for (const b of batches) expect(b.changes.length).toBeLessThanOrEqual(100);
	});

	it("D6 — cursor seq is monotonically increasing across chunk boundaries (T5)", async () => {
		const engine = await buildEngine(250, 100);
		const seqs: number[] = [];
		for await (const b of engine.changes(scope, null)) {
			if (b.cursor) seqs.push(b.cursor._seq);
		}
		for (let i = 1; i < seqs.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: i and i-1 are within seqs bounds
			expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
		}
	});

	it("D6 — no chunkSize opt: 5 changes yields 1 batch (no chunking regression)", async () => {
		const engine = new Engine(clock);
		for (let i = 1; i <= 5; i++) {
			await engine.apply({
				scope,
				changes: [
					{
						id: makeChangeId(`c-small-${i}`),
						kind: "state",
						scope,
						unit: makeConflictUnit(`u-s${i}`),
						lifetime: DURABLE,
						value: `v${i}`,
						version: clock.mint(),
					},
				],
			});
		}
		const batches: ChangeBatch[] = [];
		for await (const b of engine.changes(scope, null)) batches.push(b);
		expect(batches).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: batches.length asserted to be 1 above
		expect(batches[0]!.changes).toHaveLength(5);
	});

	it("D6 — changes(scope, midCursor) yields correct tail across chunk boundary", async () => {
		const engine = await buildEngine(250, 100);
		// Construct a cursor at seq=150 to get exactly 100 remaining changes (151-250)
		const midCursor = { _seq: 150 } as import("../../src/core/types.ts").Cursor;
		const tail: ChangeBatch[] = [];
		for await (const b of engine.changes(scope, midCursor)) tail.push(b);
		expect(tail.flatMap((b) => b.changes).length).toBe(100);
	});
});
