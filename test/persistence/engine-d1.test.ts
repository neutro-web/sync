import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { MemoryStore } from "../../src/core/persistence.ts";
import {
	type ChangeBatch,
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";

const scope = makeScope("s-d1");
const clock = new LWWClockStrategy(0);

function makeStateBatch(
	unitKey: string,
	value: unknown,
	id: string,
): ChangeBatch {
	return {
		scope,
		changes: [
			{
				id: makeChangeId(id),
				kind: "state",
				scope,
				unit: makeConflictUnit(unitKey),
				lifetime: DURABLE,
				value,
				version: clock.mint(),
			},
		],
	};
}

describe("Engine + MemoryStore (D1)", () => {
	it("D1 — apply + hydrateScope round-trips a durable change", async () => {
		const store = new MemoryStore();
		const e1 = new Engine(clock, { store });
		await e1.hydrateScope(scope);
		await e1.apply(makeStateBatch("u1", "hello", "d1-1"));
		await Promise.resolve(); // flush fire-and-forget writes

		const e2 = new Engine(clock, { store });
		await e2.hydrateScope(scope);
		const snap = await e2.snapshot(scope);
		expect(snap.changes).toHaveLength(1);
		// biome-ignore lint/suspicious/noExplicitAny: test-only value access
		expect((snap.changes[0] as any).value).toBe("hello");
	});

	it("D1 — cursor resumes at correct seq after hydrateScope", async () => {
		const store = new MemoryStore();
		const e1 = new Engine(clock, { store });
		await e1.hydrateScope(scope);
		await e1.apply(makeStateBatch("u1", "v1", "d1-2a"));
		await e1.apply(makeStateBatch("u2", "v2", "d1-2b"));
		await Promise.resolve();

		const e2 = new Engine(clock, { store });
		await e2.hydrateScope(scope);
		expect(e2.getCursor(scope)._seq).toBe(2);
	});

	it("D1 — Engine without store behaves identically to before (regression guard)", async () => {
		const plain = new Engine(clock);
		await plain.apply(makeStateBatch("u1", "plain", "d1-3"));
		const snap = await plain.snapshot(scope);
		// biome-ignore lint/suspicious/noExplicitAny: test-only value access
		expect((snap.changes[0] as any).value).toBe("plain");
	});
});
