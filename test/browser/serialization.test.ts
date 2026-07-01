import { describe, expect, it } from "vitest";
import {
	DURABLE,
	ephemeral,
	makeChangeId,
	makeConflictUnit,
	makeCursor,
	makeScope,
} from "../../src/core/types.ts";
import { vectorClock } from "../../src/strategies/index.ts";
import { decodeBatch, encodeBatch } from "../../src/transports/wire-codec.ts";

function representativeBatch() {
	const scope = makeScope("s-wire");
	const clock = vectorClock("node-a");
	const v1 = clock.mint();
	const v2 = clock.mint(v1);
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: { nested: { n: 1, list: [1, 2, 3] } },
				version: v1,
			},
			{
				id: makeChangeId("c2"),
				kind: "op" as const,
				scope,
				unit: makeConflictUnit("u2"),
				lifetime: ephemeral(5000),
				value: "increment",
				version: v2,
			},
		],
		cursor: makeCursor(scope, 2),
		atomic: true,
	};
}

describe("T0-2 — wire codec round-trip", () => {
	it("decoded Version still satisfies ClockStrategy.compare (self-consistent after round-trip)", () => {
		const clock = vectorClock("node-a");
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));

		const originalV1 = (batch.changes[0] as { version: unknown }).version;
		const decodedV1 = (decoded.changes[0] as { version: unknown }).version;
		// A version compared against its own JSON round-trip must not register
		// as before/after — the decoded token must be structurally identical.
		expect(decoded.changes[0]).toMatchObject({});
		expect(() =>
			clock.compare(
				// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
				decodedV1 as any,
				// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
				originalV1 as any,
			),
		).not.toThrow();
		expect(decodedV1).toEqual(originalV1);
	});

	it("id/unit/scope/cursor/lifetime/atomic all round-trip intact", () => {
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));

		expect(decoded.scope.key).toBe(batch.scope.key);
		expect(decoded.cursor?._seq).toBe(2);
		expect(decoded.atomic).toBe(true);
		expect(decoded.changes).toHaveLength(2);
		expect(decoded.changes[0].id.value).toBe("c1");
		expect(decoded.changes[0].unit.key).toBe("u1");
		expect(decoded.changes[0].lifetime).toEqual({ class: "durable" });
		expect(decoded.changes[1].lifetime).toEqual({
			class: "ephemeral",
			ttlMs: 5000,
		});
	});

	it("value of a structured-cloneable-shaped type round-trips through JSON", () => {
		const batch = representativeBatch();
		const decoded = decodeBatch(encodeBatch(batch));
		expect(decoded.changes[0].value).toEqual({
			nested: { n: 1, list: [1, 2, 3] },
		});
	});
});

describe("T0-1 — structuredClone round-trip (BroadcastChannel transfer mechanism)", () => {
	it("Version survives structuredClone and remains compare-consistent", () => {
		const clock = vectorClock("node-a");
		const batch = representativeBatch();
		const cloned = structuredClone(batch);

		const originalV1 = (batch.changes[0] as { version: unknown }).version;
		const clonedV1 = (cloned.changes[0] as { version: unknown }).version;
		expect(() =>
			clock.compare(
				// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
				clonedV1 as any,
				// biome-ignore lint/suspicious/noExplicitAny: comparing branded Version tokens in test
				originalV1 as any,
			),
		).not.toThrow();
		expect(clonedV1).toEqual(originalV1);
	});

	it("ConflictUnit.key, ChangeId.value, Scope.key, Cursor._seq, lifetime all match post-clone", () => {
		const batch = representativeBatch();
		const cloned = structuredClone(batch);

		expect(cloned.scope.key).toBe(batch.scope.key);
		expect(cloned.cursor?._seq).toBe(batch.cursor?._seq);
		expect(cloned.changes[0].id.value).toBe(batch.changes[0].id.value);
		expect(cloned.changes[0].unit.key).toBe(batch.changes[0].unit.key);
		expect(cloned.changes[0].lifetime).toEqual(batch.changes[0].lifetime);
		expect(cloned.changes[1].lifetime).toEqual(batch.changes[1].lifetime);
	});

	it("value round-trips for structured-cloneable payload types", () => {
		const batch = representativeBatch();
		const cloned = structuredClone(batch);
		expect(cloned.changes[0].value).toEqual(batch.changes[0].value);
	});

	it("a non-cloneable value (function) throws at the clone boundary rather than silently dropping", () => {
		const scope = makeScope("s-wire-bad");
		const badBatch = {
			scope,
			changes: [
				{
					id: makeChangeId("c-bad"),
					kind: "state" as const,
					scope,
					unit: makeConflictUnit("u-bad"),
					lifetime: DURABLE,
					value: () => {}, // functions are not structured-cloneable
					version: vectorClock("node-a").mint(),
				},
			],
		};
		expect(() => structuredClone(badBatch)).toThrow();
	});
});
