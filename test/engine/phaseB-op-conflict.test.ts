/**
 * Phase B gate tests — Group B2 (`_applyOp` concurrent routing).
 * Gate file: docs/gates/phaseB-sandbox-gaps.md
 *
 * B2-1 (opUnitChanges: Map<string, VersionedChange>; typecheck clean) is verified by
 * `pnpm typecheck` + `git show HEAD:src/core/engine.ts | grep -n opUnitChanges` — not a
 * runtime assertion, no test here for it.
 *
 * Note on observability: `opUnitChanges` has no public read surface (unlike state, which
 * is readable via `Engine.snapshot()`). Several assertions below therefore prove the
 * confirmed-op-state behaviorally — either via the durable log (the last log entry for a
 * unit always mirrors `opUnitChanges`'s current value for durable ops, since every accept
 * path that updates one also appends to the other in the same step) or via a follow-up
 * write whose accept/conflict outcome depends on which version is actually held as
 * "existing".
 */

import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.ts";
import { ResolverPump } from "../../src/core/resolver-pump.ts";
import {
	DURABLE,
	ephemeral,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import type {
	Change,
	ChangeBatch,
	Conflict,
	Lifetime,
	Resolution,
	Resolver,
	Scope,
	Version,
} from "../../src/core/types.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { drainChannels, setupGossip } from "../harness/gossip-harness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an op-with-version ChangeBatch for a single change. */
function makeVersionedOpBatch(
	scope: Scope,
	unitKey: string,
	value: unknown,
	id: string,
	version: Version,
	lifetime: Lifetime = DURABLE,
): ChangeBatch {
	return {
		scope,
		changes: [
			{
				id: makeChangeId(id),
				scope,
				unit: makeConflictUnit(unitKey),
				kind: "op",
				lifetime,
				value,
				version,
			},
		],
	};
}

/** Make a pure-intent op ChangeBatch (no version). */
function makePureOpBatch(
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

/**
 * The last durable-log entry for `unitKey` of kind "op" — mirrors `opUnitChanges`'s
 * current value for durable ops (see file-level note above).
 */
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

async function countDurableLogEntries(
	engine: Engine,
	scope: Scope,
): Promise<number> {
	let count = 0;
	for await (const batch of engine.changes(scope, null)) {
		count += batch.changes.length;
	}
	return count;
}

// ---------------------------------------------------------------------------
// B2-2 — Op concurrent builds a Conflict and enters Model C detect-and-hold
// ---------------------------------------------------------------------------

describe("B2-2 · op concurrent detect-and-hold", () => {
	it("two concurrent op-with-version writes to the same unit open a conflict; neither id seen; confirmed state unchanged", async () => {
		const clockA = new VectorClockStrategy("A");
		const clockB = new VectorClockStrategy("B");
		const scope = makeScope("b2-2-doc");
		const engine = new Engine(new VectorClockStrategy("engine"));

		const captured: Conflict[] = [];
		engine.subscribe(scope, {
			onBatch: () => {},
			onConflict: (c) => {
				captured.push(c);
				return { decision: "defer" as const };
			},
		});

		// Local op-with-version, accepted directly (no prior entry for the unit).
		const vLocal = clockA.mint(); // { A: 1 }
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-local", "id-local", vLocal),
		);

		// Remote op-with-version, minted with no knowledge of vLocal → concurrent.
		const vRemote = clockB.mint(); // { B: 1 }
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-remote", "id-remote", vRemote),
		);

		// Conflict recorded; both sides are full VersionedChange, both kind "op".
		expect(captured).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) asserted above
		const conflict = captured[0]!;
		expect(conflict.local.kind).toBe("op");
		expect(conflict.remote.kind).toBe("op");
		expect(conflict.local.value).toBe("op-local");
		expect(conflict.remote.value).toBe("op-remote");
		// VersionedChange (op variant) guarantees `.version` at the type level;
		// assert it's actually present at runtime too.
		expect(
			conflict.local.kind === "op" ? conflict.local.version : undefined,
		).toBeDefined();
		expect(
			conflict.remote.kind === "op" ? conflict.remote.version : undefined,
		).toBeDefined();

		// Neither id was added to seenIds: redelivering the exact same remote batch
		// must re-trigger detection (not be silently deduped at the top of apply()).
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-remote", "id-remote", vRemote),
		);
		expect(captured).toHaveLength(2);

		// Confirmed op state unchanged while the conflict is open: a THIRD write
		// minted as a direct successor of vLocal (no knowledge of vRemote) must be
		// accepted as "after" — not flagged a second conflict against vRemote. If
		// `existing` had been silently overwritten by vRemote, this would instead
		// compare "concurrent" against vRemote and open a second conflict.
		const vLocal2 = clockA.mint(vLocal); // { A: 2 } — knows vLocal only
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-local-2", "id-local-2", vLocal2),
		);
		expect(captured).toHaveLength(2); // no new conflict — accepted cleanly
		expect(await getLastOpValue(engine, scope, "u1")).toBe("op-local-2");
	});
});

// ---------------------------------------------------------------------------
// B2-3 — Op conflict resolves via resolveConflict; winner lands on the op path
// ---------------------------------------------------------------------------

describe("B2-3 · op resolveConflict lands on op path", () => {
	it("take-remote (durable): winner in opUnitChanges, cursor +1, log +1, onBatch fired, no state-map writes, redelivery skipped", async () => {
		const clockA = new VectorClockStrategy("A");
		const clockB = new VectorClockStrategy("B");
		const scope = makeScope("b2-3-doc");
		const unit = makeConflictUnit("u1");
		const engine = new Engine(new VectorClockStrategy("engine"));

		const batches: ChangeBatch[] = [];
		engine.subscribe(scope, {
			onBatch: (b) => batches.push(b),
			onConflict: () => ({ decision: "defer" as const }),
		});

		const vLocal = clockA.mint();
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-local", "id-local", vLocal),
		);
		const vRemote = clockB.mint(); // concurrent
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-remote", "id-remote", vRemote),
		);

		const cursorBefore = engine.getCursor(scope)._seq;
		const logCountBefore = await countDurableLogEntries(engine, scope);
		batches.length = 0; // clear pre-resolve notifications

		engine.resolveConflict(scope, unit, { decision: "take-remote" });

		// Winner accepted on the op path.
		expect(await getLastOpValue(engine, scope, "u1")).toBe("op-remote");

		// Cursor advanced by exactly 1; log gained exactly 1 entry (causal order:
		// local was already in the log before resolution; remote is now appended).
		expect(engine.getCursor(scope)._seq).toBe(cursorBefore + 1);
		const logCountAfter = await countDurableLogEntries(engine, scope);
		expect(logCountAfter).toBe(logCountBefore + 1);

		// onBatch fired with the op.
		expect(batches).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) asserted above
		expect(batches[0]!.changes[0]!.kind).toBe("op");
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) asserted above
		expect(batches[0]!.changes[0]!.value).toBe("op-remote");
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) asserted above
		expect(batches[0]!.cursor).toBeDefined(); // durable → cursor present

		// Op winners never touch the state-unit maps: snapshot() (state-only) has
		// no entry for this unit.
		const snap = await engine.snapshot(scope);
		expect(snap.changes.find((c) => c.unit.key === "u1")).toBeUndefined();

		// Both input ids now in seenIds: redelivering either original input is a
		// silent no-op (no new conflict, no new log entry).
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-local", "id-local", vLocal),
		);
		await engine.apply(
			makeVersionedOpBatch(scope, "u1", "op-remote", "id-remote", vRemote),
		);
		expect(await countDurableLogEntries(engine, scope)).toBe(logCountAfter);
		expect(batches).toHaveLength(1); // no new onBatch from the redelivery
	});

	it("take-remote (ephemeral): winner lands on op path without advancing cursor/log", async () => {
		const clockA = new VectorClockStrategy("A");
		const clockB = new VectorClockStrategy("B");
		const scope = makeScope("b2-3-ephemeral");
		const unit = makeConflictUnit("u1");
		const engine = new Engine(new VectorClockStrategy("engine"));
		const ttl = ephemeral(60_000);

		const batches: ChangeBatch[] = [];
		engine.subscribe(scope, {
			onBatch: (b) => batches.push(b),
			onConflict: () => ({ decision: "defer" as const }),
		});

		const vLocal = clockA.mint();
		await engine.apply(
			makeVersionedOpBatch(
				scope,
				"u1",
				"eph-local",
				"id-eph-local",
				vLocal,
				ttl,
			),
		);
		const vRemote = clockB.mint();
		await engine.apply(
			makeVersionedOpBatch(
				scope,
				"u1",
				"eph-remote",
				"id-eph-remote",
				vRemote,
				ttl,
			),
		);

		const cursorBefore = engine.getCursor(scope)._seq;
		const logCountBefore = await countDurableLogEntries(engine, scope);
		batches.length = 0;

		engine.resolveConflict(scope, unit, { decision: "take-remote" });

		// Cursor and durable log untouched — ephemeral op winner never enters them.
		expect(engine.getCursor(scope)._seq).toBe(cursorBefore);
		expect(await countDurableLogEntries(engine, scope)).toBe(logCountBefore);

		// onBatch still fires, but with no cursor (ephemeral).
		expect(batches).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) asserted above
		expect(batches[0]!.cursor).toBeUndefined();

		// Winner did land in opUnitChanges: a follow-up write minted as a direct
		// successor of vRemote (not vLocal) must be accepted as "after", proving
		// `existing` is now the remote winner.
		const vRemote2 = clockB.mint(vRemote);
		await engine.apply(
			makeVersionedOpBatch(
				scope,
				"u1",
				"eph-remote-2",
				"id-eph-remote-2",
				vRemote2,
				ttl,
			),
		);
		// Accepted cleanly (no new conflict): onBatch count increases by exactly 1.
		expect(batches).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// B2-4 — 2-replica op convergence under fault injection
// ---------------------------------------------------------------------------

describe("B2-4 · op convergence under faults", () => {
	it("two replicas independently resolve a concurrent op-with-version conflict to the same winner", async () => {
		// Deterministic pure-function resolver — symmetric pick-by-id (Phase 2's
		// proven approach (a)), reused here for the op path.
		const deterministicResolver: Resolver = {
			resolve(conflict: Conflict): Resolution {
				return conflict.local.id.value > conflict.remote.id.value
					? { decision: "take-local" }
					: { decision: "take-remote" };
			},
		};

		const clockA = new VectorClockStrategy("A");
		const clockB = new VectorClockStrategy("B");
		const scope = makeScope("b2-4-doc");

		const engineA = new Engine(new VectorClockStrategy("engine-A"));
		const engineB = new Engine(new VectorClockStrategy("engine-B"));

		new ResolverPump(engineA, deterministicResolver, scope);
		new ResolverPump(engineB, deterministicResolver, scope);

		const { allChannels, throwIfErrors } = setupGossip(
			[engineA, engineB],
			scope,
			12,
			{ dropRate: 0.3, reorderRate: 0.3, duplicateRate: 0.2 },
		);

		// Both replicas write the same unit concurrently, before exchanging.
		// "id-op-A" < "id-op-B" lexicographically → B's write is the expected winner.
		const vA = clockA.mint();
		const vB = clockB.mint();
		await engineA.apply(
			makeVersionedOpBatch(scope, "u1", "op-val-A", "id-op-A", vA),
		);
		await engineB.apply(
			makeVersionedOpBatch(scope, "u1", "op-val-B", "id-op-B", vB),
		);

		await drainChannels(allChannels);
		throwIfErrors();

		const winnerA = await getLastOpValue(engineA, scope, "u1");
		const winnerB = await getLastOpValue(engineB, scope, "u1");

		expect(winnerA).toBe(winnerB);
		expect(winnerA).toBe("op-val-B"); // "id-op-B" > "id-op-A"

		// No open conflict remains: resolveConflict(take-local) on either engine is
		// a no-op (already resolved) — winner is unchanged.
		engineA.resolveConflict(scope, makeConflictUnit("u1"), {
			decision: "take-local",
		});
		expect(await getLastOpValue(engineA, scope, "u1")).toBe("op-val-B");
	});
});

// ---------------------------------------------------------------------------
// B2-5 — Pure-intent ops (no version) are unaffected
// ---------------------------------------------------------------------------

describe("B2-5 · pure-intent op regression", () => {
	it("a versionless op still dedups by id only — applied exactly once under duplicateRate 1.0", async () => {
		const scope = makeScope("b2-5-doc");
		const engine0 = new Engine(new VectorClockStrategy("node-0"));
		const engine1 = new Engine(new VectorClockStrategy("node-1"));

		const { allChannels, throwIfErrors } = setupGossip(
			[engine0, engine1],
			scope,
			710,
			{ duplicateRate: 1.0 },
		);

		const opBatch = makePureOpBatch(
			scope,
			"cmd",
			"do-something",
			"op-no-version",
		);
		await engine0.apply(opBatch);
		await drainChannels(allChannels);
		throwIfErrors();

		let opCount = 0;
		for await (const batch of engine1.changes(scope, null)) {
			for (const c of batch.changes) {
				if (c.id.value === "op-no-version") opCount++;
			}
		}
		expect(opCount).toBe(1);
	});
});
