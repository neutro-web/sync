import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/core/persistence.ts";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";

function makeStateChange(seq: number) {
	return {
		id: makeChangeId(`c-${seq}`),
		kind: "state" as const,
		scope: makeScope("s1"),
		unit: makeConflictUnit("u1"),
		lifetime: DURABLE,
		value: `val-${seq}`,
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub version
		version: { _ts: seq, _node: 0 } as any,
	};
}

describe("MemoryStore", () => {
	let store: MemoryStore;
	beforeEach(() => {
		store = new MemoryStore();
	});

	it("D1 — appendChange + readChanges round-trips", async () => {
		const c1 = makeStateChange(1);
		const c2 = makeStateChange(2);
		await store.appendChange("s1", { change: c1, seq: 1 });
		await store.appendChange("s1", { change: c2, seq: 2 });
		const rows = await store.readChanges("s1");
		expect(rows).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length guarded by toHaveLength(2) above
		expect(rows[0]!.seq).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: length guarded by toHaveLength(2) above
		expect(rows[1]!.seq).toBe(2);
	});

	it("D1 — readChanges(since) returns only rows with seq > since", async () => {
		for (let i = 1; i <= 3; i++)
			await store.appendChange("s1", { change: makeStateChange(i), seq: i });
		const rows = await store.readChanges("s1", 1);
		expect(rows).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length guarded by toHaveLength(2) above
		expect(rows[0]!.seq).toBe(2);
	});

	it("D1 — writeCursor + readCursor round-trips", async () => {
		expect(await store.readCursor("s1")).toBeNull();
		await store.writeCursor("s1", 5);
		expect(await store.readCursor("s1")).toBe(5);
	});

	it("D1 — scopes are isolated", async () => {
		await store.appendChange("s1", { change: makeStateChange(1), seq: 1 });
		expect(await store.readChanges("s2")).toHaveLength(0);
	});

	it("D1 — clear() wipes all state", async () => {
		await store.appendChange("s1", { change: makeStateChange(1), seq: 1 });
		await store.writeCursor("s1", 1);
		await store.clear();
		expect(await store.readChanges("s1")).toHaveLength(0);
		expect(await store.readCursor("s1")).toBeNull();
	});
});
