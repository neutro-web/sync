/**
 * Phase B gate tests — Group B1 (CRDT-position strategy).
 * Gate file: docs/gates/phaseB-sandbox-gaps.md
 *
 * B1-1 (CRDTPositionStrategy exported with mergeVersions; typecheck clean) is
 * verified by `pnpm typecheck` + `git show HEAD:src/strategies/crdt-position.ts`
 * + `src/strategies/index.ts` — not a runtime assertion, no test here for it.
 *
 * Scope boundary (see src/strategies/crdt-position.ts docstring): a
 * position-ordered ClockStrategy sufficient to exercise the seq-position
 * version space and prove convergence on the harness — not a full production
 * sequence CRDT.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import type {
	Change,
	ChangeBatch,
	Conflict,
	ConflictUnit,
	Resolution,
	Scope,
	Version,
} from "../../src/core/types.ts";
import { CRDTPositionStrategy } from "../../src/strategies/crdt-position.ts";
import { drainChannels, setupGossip } from "../harness/gossip-harness.ts";

const SCOPE = makeScope("doc-1");
const UNIT = makeConflictUnit("position-1");

// ---------------------------------------------------------------------------
// B1-2 — compare semantics
// ---------------------------------------------------------------------------

describe("B1-2 · CRDTPositionStrategy.compare: total order on distinct positions; concurrent only on equal position", () => {
	it("a chain of mint(prev) extensions is totally ordered: antisymmetric and transitive over the sampled set", () => {
		const clock = new CRDTPositionStrategy("node-A");
		// Chain: v0 -> v1 -> v2 -> v3 -> v4, each minted as a successor of the last.
		const chain: Version[] = [];
		let prev: Version | undefined;
		for (let i = 0; i < 5; i++) {
			prev = clock.mint(prev);
			chain.push(prev);
		}

		// Antisymmetric: for every distinct pair, compare(x,y) is the strict
		// opposite of compare(y,x).
		for (let i = 0; i < chain.length; i++) {
			for (let j = 0; j < chain.length; j++) {
				if (i === j) continue;
				// biome-ignore lint/style/noNonNullAssertion: i,j < chain.length
				const xy = clock.compare(chain[i]!, chain[j]!);
				// biome-ignore lint/style/noNonNullAssertion: i,j < chain.length
				const yx = clock.compare(chain[j]!, chain[i]!);
				expect(xy === "before" || xy === "after").toBe(true);
				expect(yx).toBe(xy === "before" ? "after" : "before");
			}
		}

		// Consistent with construction order: chain[i] is before chain[j] for i<j.
		for (let i = 0; i < chain.length; i++) {
			for (let j = i + 1; j < chain.length; j++) {
				// biome-ignore lint/style/noNonNullAssertion: i,j < chain.length
				expect(clock.compare(chain[i]!, chain[j]!)).toBe("before");
				// biome-ignore lint/style/noNonNullAssertion: i,j < chain.length
				expect(clock.compare(chain[j]!, chain[i]!)).toBe("after");
			}
		}

		// Transitive: chain[0] < chain[2] < chain[4] implies chain[0] < chain[4]
		// (already covered above, asserted explicitly here for clarity).
		// biome-ignore lint/style/noNonNullAssertion: chain has 5 entries
		expect(clock.compare(chain[0]!, chain[2]!)).toBe("before");
		// biome-ignore lint/style/noNonNullAssertion: chain has 5 entries
		expect(clock.compare(chain[2]!, chain[4]!)).toBe("before");
		// biome-ignore lint/style/noNonNullAssertion: chain has 5 entries
		expect(clock.compare(chain[0]!, chain[4]!)).toBe("before");
	});

	it("branching positions (siblings under a shared prefix) are still totally ordered, not concurrent", () => {
		const clock = new CRDTPositionStrategy("node-A");
		const root = clock.mint(); // [0]
		const childA = clock.mint(root); // [0, 1]
		const childB = clock.mint(root); // [0, 2] — same instance, different seq
		// Both are distinct extensions of root, minted from the SAME instance at
		// different _seq values — distinct paths, not concurrent.
		expect(clock.compare(childA, childB)).not.toBe("concurrent");
	});

	it("two independently-minted unanchored versions land at the same insertion point and compare concurrent", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint(); // [0], node-A
		const vB = clockB.mint(); // [0], node-B — same path, different node
		expect(clockA.compare(vA, vB)).toBe("concurrent");
		expect(clockA.compare(vB, vA)).toBe("concurrent");
	});

	it("identical token (same path, same node) compares before (idempotent re-apply)", () => {
		const clock = new CRDTPositionStrategy("node-A");
		const v = clock.mint();
		expect(clock.compare(v, v)).toBe("before");
	});

	it("a version minted after observing another (mint(prev)) is causally later, not concurrent with prev", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint(); // [0]
		const vB = clockB.mint(vA); // [0, 1] — extends vA, even though minted by a different node
		expect(clockB.compare(vB, vA)).toBe("after");
		expect(clockB.compare(vA, vB)).toBe("before");
	});
});

// ---------------------------------------------------------------------------
// B1-3 — mergeVersions dominates + is replica-identical
// ---------------------------------------------------------------------------

describe("B1-3 · CRDTPositionStrategy.mergeVersions: dominates both inputs, replica-identical, rejects the increment trap", () => {
	it("mergeVersions is defined", () => {
		const clock = new CRDTPositionStrategy("node-A");
		expect(typeof clock.mergeVersions).toBe("function");
	});

	it("merged version dominates a and b (compare returns after for both)", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint(); // [0]
		const vB = clockB.mint(); // [0] — concurrent with vA
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(merged, vA)).toBe("after");
		expect(clockA.compare(merged, vB)).toBe("after");
	});

	it("order-independent: merge(a,b) compare-equals merge(b,a)", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint();
		const vB = clockB.mint();
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const mergeAB = clockA.mergeVersions!(vA, vB);
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const mergeBA = clockA.mergeVersions!(vB, vA);
		expect(clockA.compare(mergeAB, mergeBA)).toBe("before"); // equal -> before
		expect(clockA.compare(mergeBA, mergeAB)).toBe("before");
	});

	it("replica-identical: two DIFFERENT strategy instances merging the same (a,b) pair agree (compare-equal), not just the same instance", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint();
		const vB = clockB.mint();

		// Replica A computes the merge using ITS OWN strategy instance.
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const mergedOnA = clockA.mergeVersions!(vA, vB);
		// Replica B computes the SAME merge using A DIFFERENT strategy instance —
		// this is the trap case: if the tag were derived from `this._nodeId`
		// (the CALLING instance) rather than purely from vA/vB's own node ids,
		// these two results would diverge (mutually concurrent), not agree.
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const mergedOnB = clockB.mergeVersions!(vA, vB);

		expect(clockA.compare(mergedOnA, mergedOnB)).toBe("before"); // equal
		expect(clockB.compare(mergedOnB, mergedOnA)).toBe("before");
		// And neither is concurrent with the other — the explicit rejection of
		// the max-then-local-increment trap named in the 2026-06-29 merge decision.
		expect(clockA.compare(mergedOnA, mergedOnB)).not.toBe("concurrent");
	});

	it("original inputs compare before the merged version (redelivery is skipped)", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint();
		const vB = clockB.mint();
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(vA, merged)).toBe("before");
		expect(clockA.compare(vB, merged)).toBe("before");
	});

	it("post-merge local write (mint(merged)) dominates the merged version", () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const vA = clockA.mint();
		const vB = clockB.mint();
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined
		const merged = clockA.mergeVersions!(vA, vB);
		const postMerge = clockA.mint(merged);
		expect(clockA.compare(postMerge, merged)).toBe("after");
	});
});

// ---------------------------------------------------------------------------
// B1-4 — 2-replica STATE convergence on the harness
// ---------------------------------------------------------------------------

function makeStateBatch(
	scope: Scope,
	unit: ConflictUnit,
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
				unit,
				kind: "state",
				lifetime: DURABLE,
				value,
				version,
			},
		],
	};
}

async function getUnitValue(
	engine: Engine,
	scope: Scope,
	unit: ConflictUnit,
): Promise<unknown> {
	const snap = await engine.snapshot(scope);
	return snap.changes.find((c) => c.unit.key === unit.key)?.value;
}

function symmetricMergedResolver(_conflict: Conflict): Resolution {
	return { decision: "merged", value: "merged-position-value" };
}

describe("B1-4 · 2-replica state convergence at the same insertion point", () => {
	it("two replicas insert concurrently at the same position; under fault injection both converge on the merged value via mergeVersions", async () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const engineA = new Engine(clockA);
		const engineB = new Engine(clockB);

		new ResolverPump(engineA, { resolve: symmetricMergedResolver }, SCOPE);
		new ResolverPump(engineB, { resolve: symmetricMergedResolver }, SCOPE);

		const { allChannels, throwIfErrors } = setupGossip(
			[engineA, engineB],
			SCOPE,
			800,
			{ dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 },
		);

		// Both replicas insert at the SAME (unanchored) position — concurrent by
		// construction under CRDTPositionStrategy.
		const vA = clockA.mint(); // [0], node-A
		const vB = clockB.mint(); // [0], node-B
		await engineA.apply(makeStateBatch(SCOPE, UNIT, "value-A", "write-A", vA));
		await engineB.apply(makeStateBatch(SCOPE, UNIT, "value-B", "write-B", vB));

		await drainChannels(allChannels);
		throwIfErrors();

		const valueA = await getUnitValue(engineA, SCOPE, UNIT);
		const valueB = await getUnitValue(engineB, SCOPE, UNIT);
		expect(valueA).toBe("merged-position-value");
		expect(valueB).toBe("merged-position-value");

		// Redelivering either original input compares "before" the merged
		// version and is skipped — no re-conflict. Proven behaviorally: a second
		// resolveConflict(take-remote) call on either engine must be a no-op
		// (no open conflict survives), leaving the merged value unchanged.
		engineA.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
		expect(await getUnitValue(engineA, SCOPE, UNIT)).toBe(
			"merged-position-value",
		);
		engineB.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
		expect(await getUnitValue(engineB, SCOPE, UNIT)).toBe(
			"merged-position-value",
		);
	});
});

// ---------------------------------------------------------------------------
// B1-5 — 2-replica OP convergence on the harness (parity with B2; depends on
// B2's op concurrent routing being live)
// ---------------------------------------------------------------------------

function makeVersionedOpBatch(
	scope: Scope,
	unit: ConflictUnit,
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
				unit,
				kind: "op",
				lifetime: DURABLE,
				value,
				version,
			},
		],
	};
}

async function getLastOpValue(
	engine: Engine,
	scope: Scope,
	unitKey: string,
): Promise<unknown> {
	let last: Change | undefined;
	for await (const batch of engine.changes(scope, null)) {
		for (const c of batch.changes) {
			if (c.kind === "op" && c.unit.key === unitKey) last = c;
		}
	}
	return last?.value;
}

describe("B1-5 · 2-replica op convergence at the same insertion point", () => {
	it("two replicas insert a concurrent op at the same position; under fault injection both converge on the merged value via the op path", async () => {
		const clockA = new CRDTPositionStrategy("node-A");
		const clockB = new CRDTPositionStrategy("node-B");
		const engineA = new Engine(clockA);
		const engineB = new Engine(clockB);
		const scope = makeScope("b1-5-doc");
		const unit = makeConflictUnit("seq-1");

		new ResolverPump(engineA, { resolve: symmetricMergedResolver }, scope);
		new ResolverPump(engineB, { resolve: symmetricMergedResolver }, scope);

		const { allChannels, throwIfErrors } = setupGossip(
			[engineA, engineB],
			scope,
			17,
			{ dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 },
		);

		const vA = clockA.mint(); // [0], node-A
		const vB = clockB.mint(); // [0], node-B
		await engineA.apply(
			makeVersionedOpBatch(scope, unit, "op-value-A", "op-write-A", vA),
		);
		await engineB.apply(
			makeVersionedOpBatch(scope, unit, "op-value-B", "op-write-B", vB),
		);

		await drainChannels(allChannels);
		throwIfErrors();

		const winnerA = await getLastOpValue(engineA, scope, unit.key);
		const winnerB = await getLastOpValue(engineB, scope, unit.key);
		expect(winnerA).toBe("merged-position-value");
		expect(winnerB).toBe("merged-position-value");

		// No open conflict survives: a second resolveConflict on either engine
		// is a no-op.
		engineA.resolveConflict(scope, unit, { decision: "take-remote" });
		expect(await getLastOpValue(engineA, scope, unit.key)).toBe(
			"merged-position-value",
		);
	});
});
