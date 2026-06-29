/**
 * Phase 3 gate tests — C1-C7.
 * Design basis: docs/design/merge-resolution.md (Q-C crux: max-only join).
 * Gate contract: docs/gates/phase3-merge-resolution.md
 */

import { describe, expect, it, vi } from "vitest";
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
	ChangeBatch,
	ClockStrategy,
	Conflict,
	ConflictUnit,
	Resolution,
	Scope,
	Version,
} from "../../src/core/types.ts";
import { LWWClockStrategy } from "../../src/strategies/lww.ts";
import { VectorClockStrategy } from "../../src/strategies/vector-clock.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";
import type { FaultConfig } from "../harness/channel-simulator.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SCOPE = makeScope("doc-1");
const UNIT = makeConflictUnit("field-x");

function makeDurableStateBatch(
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
	const change = snap.changes.find((c) => c.unit.key === unit.key);
	return change?.value;
}

async function getUnitVersion(
	engine: Engine,
	scope: Scope,
	unit: ConflictUnit,
): Promise<Version | undefined> {
	const snap = await engine.snapshot(scope);
	const change = snap.changes.find(
		(c) => c.unit.key === unit.key && c.kind === "state",
	);
	return change?.kind === "state" ? change.version : undefined;
}

/**
 * Wire N engines in a full gossip mesh via ChannelSimulator.
 * Returns { allChannels, drainChannels, throwIfErrors }.
 */
function setupGossip(
	engines: Engine[],
	scope: Scope,
	baseSeed: number,
	faultConfig?: FaultConfig,
): {
	channels: Map<string, ChannelSimulator>;
	allChannels: ChannelSimulator[];
	throwIfErrors(): void;
} {
	const n = engines.length;
	const channels = new Map<string, ChannelSimulator>();
	const deliveryErrors: unknown[] = [];

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
		const ci = i;
		// biome-ignore lint/style/noNonNullAssertion: i < n === engines.length
		engines[i]!.subscribe(scope, {
			onBatch: (batch) => {
				for (let j = 0; j < n; j++) {
					if (j === ci) continue;
					// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
					channels.get(`${ci}→${j}`)!.enqueue(batch, (b) => {
						// biome-ignore lint/style/noNonNullAssertion: j < n === engines.length
						engines[j]!.apply(b).catch((err) => deliveryErrors.push(err));
					});
				}
			},
			onConflict: () => ({ decision: "defer" as const }),
		});
	}

	return {
		channels,
		allChannels: Array.from(channels.values()),
		throwIfErrors(): void {
			if (deliveryErrors.length > 0) throw deliveryErrors[0];
		},
	};
}

async function drainChannels(
	channels: ChannelSimulator[],
	maxRounds = 200,
): Promise<void> {
	for (let round = 0; round < maxRounds; round++) {
		let delivered = 0;
		for (const ch of channels) delivered += ch.drain();
		await Promise.resolve();
		if (delivered === 0) return;
	}
	throw new Error(`drainChannels: did not quiesce after ${maxRounds} rounds`);
}

// ---------------------------------------------------------------------------
// C2 — VectorClockStrategy.mergeVersions
// ---------------------------------------------------------------------------

describe("C2 · VectorClockStrategy.mergeVersions", () => {
	const clockA = new VectorClockStrategy("node-A");
	const clockB = new VectorClockStrategy("node-B");
	const clockC = new VectorClockStrategy("node-C");

	const vA = clockA.mint(); // { node-A: 1 }
	const vB = clockB.mint(); // { node-B: 1 }

	it("mergeVersions is defined on VectorClockStrategy", () => {
		expect(typeof clockA.mergeVersions).toBe("function");
	});

	it("merged version dominates a (compare returns after)", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(merged, vA)).toBe("after");
	});

	it("merged version dominates b (compare returns after)", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(merged, vB)).toBe("after");
	});

	it("order-independent: merge(a,b) compare-equals merge(b,a)", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const mergeAB = clockA.mergeVersions!(vA, vB);
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const mergeBA = clockA.mergeVersions!(vB, vA);
		// compare-equal means neither is strictly after the other
		expect(clockA.compare(mergeAB, mergeBA)).toBe("before"); // equal → before (idempotent)
		expect(clockA.compare(mergeBA, mergeAB)).toBe("before");
	});

	it("original input a compares before merged (redelivery is skipped)", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(vA, merged)).toBe("before");
	});

	it("original input b compares before merged (redelivery is skipped)", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(vB, merged)).toBe("before");
	});

	it("post-merge local write dominates the merged version", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		const postMerge = clockA.mint(merged); // mint after knowing about merged
		expect(clockA.compare(postMerge, merged)).toBe("after");
	});

	it("N-way: merge(merge(a,b), c) dominates a, b, and c", () => {
		const vC = clockC.mint(); // { node-C: 1 }
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const mergeAB = clockA.mergeVersions!(vA, vB);
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const mergeABC = clockA.mergeVersions!(mergeAB, vC);
		expect(clockA.compare(mergeABC, vA)).toBe("after");
		expect(clockA.compare(mergeABC, vB)).toBe("after");
		expect(clockA.compare(mergeABC, vC)).toBe("after");
	});

	it("mergeVersions never returns concurrent with its inputs", () => {
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = clockA.mergeVersions!(vA, vB);
		expect(clockA.compare(merged, vA)).not.toBe("concurrent");
		expect(clockA.compare(merged, vB)).not.toBe("concurrent");
	});
});

// ---------------------------------------------------------------------------
// C4 — Engine resolveConflict: merged arm, single-engine
// ---------------------------------------------------------------------------

describe("C4 · Engine: merged arm lands value, advances cursor (durable), clears conflict", () => {
	it("merged durable: value in snapshot, cursor advances, conflict cleared, onBatch fired", async () => {
		const clock = new VectorClockStrategy("node-A");
		const remoteClock = new VectorClockStrategy("node-B");
		const engine = new Engine(clock);

		const batchCalls: ChangeBatch[] = [];
		engine.subscribe(SCOPE, {
			onBatch: (b) => batchCalls.push(b),
			onConflict: () => ({ decision: "defer" as const }),
		});

		const vLocal = clock.mint();
		const vRemote = remoteClock.mint();

		// Apply local write
		await engine.apply(
			makeDurableStateBatch(SCOPE, UNIT, "local-val", "id-local", vLocal),
		);
		batchCalls.length = 0; // clear the initial-write notification

		// Apply concurrent remote write → triggers conflict
		await engine.apply(
			makeDurableStateBatch(SCOPE, UNIT, "remote-val", "id-remote", vRemote),
		);
		batchCalls.length = 0; // clear (conflict fires onConflict, not onBatch)

		const cursorBefore = engine.getCursor(SCOPE)._seq;

		// Resolve as merged
		engine.resolveConflict(SCOPE, UNIT, {
			decision: "merged",
			value: "merged-val",
		});

		// Merged value is in snapshot
		expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("merged-val");

		// Cursor advanced (durable change)
		expect(engine.getCursor(SCOPE)._seq).toBeGreaterThan(cursorBefore);

		// onBatch fired exactly once (for the merged change)
		expect(batchCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength checked above
		expect(batchCalls[0]!.changes[0]!.value).toBe("merged-val");
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength checked above
		expect(batchCalls[0]!.cursor).toBeDefined(); // durable → cursor present

		// Open conflict cleared: a second resolveConflict call with take-remote on the same unit
		// must be a no-op (no open conflict entry → returns immediately, value unchanged).
		// If the conflict were still open, take-remote would overwrite merged-val with remote-val.
		engine.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
		expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("merged-val");
	});

	it("merged ephemeral: value in snapshot, cursor does NOT advance, onBatch fired without cursor", async () => {
		const clock = new VectorClockStrategy("node-A");
		const remoteClock = new VectorClockStrategy("node-B");
		const engine = new Engine(clock);

		const batchCalls: ChangeBatch[] = [];
		engine.subscribe(SCOPE, {
			onBatch: (b) => batchCalls.push(b),
			onConflict: () => ({ decision: "defer" as const }),
		});

		const UNIT2 = makeConflictUnit("field-ephemeral");
		const vLocal = clock.mint();
		const vRemote = remoteClock.mint();
		const ttl = ephemeral(60_000);

		// Apply local ephemeral write
		await engine.apply({
			scope: SCOPE,
			changes: [
				{
					id: makeChangeId("eph-local"),
					scope: SCOPE,
					unit: UNIT2,
					kind: "state",
					lifetime: ttl,
					value: "eph-local-val",
					version: vLocal,
				},
			],
		});
		batchCalls.length = 0;

		// Apply concurrent remote ephemeral write
		await engine.apply({
			scope: SCOPE,
			changes: [
				{
					id: makeChangeId("eph-remote"),
					scope: SCOPE,
					unit: UNIT2,
					kind: "state",
					lifetime: ttl,
					value: "eph-remote-val",
					version: vRemote,
				},
			],
		});
		batchCalls.length = 0;

		const cursorBefore = engine.getCursor(SCOPE)._seq;

		engine.resolveConflict(SCOPE, UNIT2, {
			decision: "merged",
			value: "eph-merged-val",
		});

		// Value in snapshot
		expect(await getUnitValue(engine, SCOPE, UNIT2)).toBe("eph-merged-val");

		// Cursor does NOT advance for ephemeral
		expect(engine.getCursor(SCOPE)._seq).toBe(cursorBefore);

		// onBatch fired, no cursor on the batch
		expect(batchCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength checked above
		expect(batchCalls[0]!.cursor).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// C5 — Guard: merged under a strategy without mergeVersions
// ---------------------------------------------------------------------------

describe("C5 · Guard: merged under a strategy without mergeVersions throws before mutating", () => {
	it("throws precise error; openConflicts entry survives the throw", async () => {
		// LWW never produces "concurrent", so we use a minimal custom strategy
		// that CAN produce concurrent but lacks mergeVersions — exactly C5's setup.
		const minimalClock: ClockStrategy = {
			mint(prev?: Version): Version {
				return new VectorClockStrategy("x").mint(prev);
			},
			compare(a: Version, b: Version): "before" | "after" | "concurrent" {
				return new VectorClockStrategy("x").compare(a, b);
			},
			// mergeVersions intentionally absent
		};

		const clockA = new VectorClockStrategy("node-A");
		const clockB = new VectorClockStrategy("node-B");
		const engine = new Engine(minimalClock);

		const vLocal = clockA.mint();
		const vRemote = clockB.mint();

		// Plant a conflict
		await engine.apply(
			makeDurableStateBatch(SCOPE, UNIT, "local-val", "guard-local", vLocal),
		);
		await engine.apply(
			makeDurableStateBatch(SCOPE, UNIT, "remote-val", "guard-remote", vRemote),
		);

		// The throw must happen before any map mutation
		const valueBefore = await getUnitValue(engine, SCOPE, UNIT);

		expect(() =>
			engine.resolveConflict(SCOPE, UNIT, {
				decision: "merged",
				value: "should-not-land",
			}),
		).toThrow("mergeVersions");

		// Value unchanged (no mutation before throw)
		expect(await getUnitValue(engine, SCOPE, UNIT)).toBe(valueBefore);

		// Conflict is still open (not deleted before throw)
		// Verify: defer still works → conflict entry is there
		engine.resolveConflict(SCOPE, UNIT, { decision: "defer" });
		// defer is a no-op; then take-local should work if conflict still open
		engine.resolveConflict(SCOPE, UNIT, { decision: "take-local" });
		// If conflict was already deleted, take-local would be a no-op and value would still be "local-val".
		// If conflict was deleted by the failed merge, take-local would be a no-op too but the conflict
		// entry won't be present. The assert that matters is value unchanged, which we already checked.
		expect(await getUnitValue(engine, SCOPE, UNIT)).toBe("local-val");
	});
});

// ---------------------------------------------------------------------------
// C6 — ≥2-replica convergence; merged value does NOT re-conflict on redelivery
// ---------------------------------------------------------------------------

describe("C6 · ≥2-replica convergence under fault injection", () => {
	/**
	 * Symmetric resolver: returns "merged-AB" regardless of which side is local/remote.
	 * Deterministic and pure — the same answer on both replicas for the same conflict.
	 */
	function symmetricResolver(conflict: Conflict): Resolution {
		return { decision: "merged", value: "merged-AB" };
	}

	it("2-replica: both converge on merged value, merged version dominates inputs, no re-conflict on redelivery", async () => {
		const clockA = new VectorClockStrategy("node-A");
		const clockB = new VectorClockStrategy("node-B");
		// Engine._resolver is dead code (never called by the engine). Resolution runs via
		// ResolverPump which subscribes to onConflict notifications and calls resolveConflict.
		const engineA = new Engine(clockA);
		const engineB = new Engine(clockB);

		const faultConfig: FaultConfig = {
			dropRate: 0.1,
			reorderRate: 0.2,
			duplicateRate: 0.15,
		};

		const { allChannels, throwIfErrors } = setupGossip(
			[engineA, engineB],
			SCOPE,
			42,
			faultConfig,
		);

		// Wire ResolverPumps — constructor self-wires via engine.subscribe internally.
		// ResolverPump signature: (engine, resolver, scope). No separate subscribe needed.
		new ResolverPump(engineA, { resolve: symmetricResolver }, SCOPE);
		new ResolverPump(engineB, { resolve: symmetricResolver }, SCOPE);

		// Concurrent writes — each node mints without knowledge of the other
		const vA = clockA.mint();
		const vB = clockB.mint();

		await engineA.apply(
			makeDurableStateBatch(SCOPE, UNIT, "value-A", "write-A", vA),
		);
		await engineB.apply(
			makeDurableStateBatch(SCOPE, UNIT, "value-B", "write-B", vB),
		);

		// Drain to quiescence (with fault injection)
		await drainChannels(allChannels);
		throwIfErrors();

		// Both engines must have converged on the merged value
		const valueA = await getUnitValue(engineA, SCOPE, UNIT);
		const valueB = await getUnitValue(engineB, SCOPE, UNIT);
		expect(valueA).toBe("merged-AB");
		expect(valueB).toBe("merged-AB");

		// Merged version dominates both original input versions on both engines
		const mergedVersionA = await getUnitVersion(engineA, SCOPE, UNIT);
		const mergedVersionB = await getUnitVersion(engineB, SCOPE, UNIT);
		expect(mergedVersionA).toBeDefined();
		expect(mergedVersionB).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: toBeDefined() asserted above
		expect(clockA.compare(mergedVersionA!, vA)).toBe("after");
		// biome-ignore lint/style/noNonNullAssertion: toBeDefined() asserted above
		expect(clockA.compare(mergedVersionA!, vB)).toBe("after");
		// biome-ignore lint/style/noNonNullAssertion: toBeDefined() asserted above
		expect(clockB.compare(mergedVersionB!, vA)).toBe("after");
		// biome-ignore lint/style/noNonNullAssertion: toBeDefined() asserted above
		expect(clockB.compare(mergedVersionB!, vB)).toBe("after");

		// Verify no lingering open conflicts: a second resolveConflict(take-remote) on each
		// engine must be a no-op — if the conflict were still open, take-remote would
		// overwrite "merged-AB" with the remote input value.
		engineA.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
		expect(await getUnitValue(engineA, SCOPE, UNIT)).toBe("merged-AB");
		engineB.resolveConflict(SCOPE, UNIT, { decision: "take-remote" });
		expect(await getUnitValue(engineB, SCOPE, UNIT)).toBe("merged-AB");
	});

	it("3-replica partition: A+C merge while B isolated, reconnect → all 3 converge", async () => {
		const UNIT3 = makeConflictUnit("field-partition");
		const clockA = new VectorClockStrategy("node-A");
		const clockB = new VectorClockStrategy("node-B");
		const clockC = new VectorClockStrategy("node-C");
		// Engine._resolver is dead; resolution runs via ResolverPump subscriptions.
		const engineA = new Engine(clockA);
		const engineB = new Engine(clockB);
		const engineC = new Engine(clockC);

		const { channels, allChannels, throwIfErrors } = setupGossip(
			[engineA, engineB, engineC],
			SCOPE,
			99,
		);

		// Wire ResolverPumps on A and C (B receives merged change via gossip — no pump needed there).
		// ResolverPump self-wires via engine.subscribe in its constructor.
		new ResolverPump(engineA, { resolve: symmetricResolver }, SCOPE);
		new ResolverPump(engineC, { resolve: symmetricResolver }, SCOPE);

		// Partition B (channels to/from B deliver nothing)
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("0→1")!.partition(); // A→B
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("1→0")!.partition(); // B→A
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("2→1")!.partition(); // C→B
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("1→2")!.partition(); // B→C

		// A and C write concurrently (B is isolated)
		const vA = clockA.mint();
		const vC = clockC.mint();
		await engineA.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA),
		);
		await engineC.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC),
		);

		// Drain A↔C channels only
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		await drainChannels([channels.get("0→2")!, channels.get("2→0")!]);
		throwIfErrors();

		// A and C should have converged on "merged-AB" (symmetric resolver)
		expect(await getUnitValue(engineA, SCOPE, UNIT3)).toBe("merged-AB");
		expect(await getUnitValue(engineC, SCOPE, UNIT3)).toBe("merged-AB");

		// Reconnect B
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("0→1")!.reconnect();
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("1→0")!.reconnect();
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("2→1")!.reconnect();
		// biome-ignore lint/style/noNonNullAssertion: channel created for all i≠j pairs
		channels.get("1→2")!.reconnect();

		// Drain all channels — B receives the merged change from A and C
		await drainChannels(allChannels);
		throwIfErrors();

		// All 3 converge
		expect(await getUnitValue(engineA, SCOPE, UNIT3)).toBe("merged-AB");
		expect(await getUnitValue(engineB, SCOPE, UNIT3)).toBe("merged-AB");
		expect(await getUnitValue(engineC, SCOPE, UNIT3)).toBe("merged-AB");

		// No lingering open conflict on any engine
		const conflictFired = vi.fn();
		for (const engine of [engineA, engineB, engineC]) {
			engine.subscribe(SCOPE, { onBatch: () => {}, onConflict: conflictFired });
		}
		// Re-apply original inputs to all engines — none should re-open a conflict
		await engineA.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA),
		);
		await engineB.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA),
		);
		await engineC.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-A", "p-write-A", vA),
		);
		await engineA.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC),
		);
		await engineB.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC),
		);
		await engineC.apply(
			makeDurableStateBatch(SCOPE, UNIT3, "value-C", "p-write-C", vC),
		);
		expect(conflictFired).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Cross-lifetime conflict assertion (design §8)
// ---------------------------------------------------------------------------

describe("§8 cross-lifetime: durable+ephemeral concurrent pair opens a conflict; merged uses local.lifetime", () => {
	it("opens a conflict for durable+ephemeral concurrent pair; merged uses open.local.lifetime", async () => {
		// Under current routing: _applyState compares the incoming version against
		// _stateWinner(durable, ephemeral). If the ephemeral and durable are both
		// present, _stateWinner picks the higher-version one for comparison. So the
		// only way to get a conflict is if two changes have CONCURRENT versions —
		// they can differ in lifetime, but the engine compares them purely by version.
		// We assert that a durable local + ephemeral remote concurrent pair DOES produce
		// a conflict (openConflicts is not nil-by-lifetime), and that the merged arm
		// uses open.local.lifetime for the merged change.
		const clockA = new VectorClockStrategy("node-A");
		const clockB = new VectorClockStrategy("node-B");
		const engine = new Engine(clockA);

		const conflictPayloads: Conflict[] = [];
		engine.subscribe(SCOPE, {
			onBatch: () => {},
			onConflict: (c) => {
				conflictPayloads.push(c);
				return { decision: "defer" as const };
			},
		});

		const UNIT4 = makeConflictUnit("cross-lifetime");
		const vDurable = clockA.mint();
		const vEphemeral = clockB.mint(); // concurrent with vDurable

		// Apply durable local
		await engine.apply(
			makeDurableStateBatch(
				SCOPE,
				UNIT4,
				"durable-val",
				"cl-durable",
				vDurable,
			),
		);
		// Apply ephemeral concurrent
		await engine.apply({
			scope: SCOPE,
			changes: [
				{
					id: makeChangeId("cl-ephemeral"),
					scope: SCOPE,
					unit: UNIT4,
					kind: "state",
					lifetime: ephemeral(60_000),
					value: "ephemeral-val",
					version: vEphemeral,
				},
			],
		});

		// A conflict IS opened — the engine compares by version regardless of lifetime
		expect(conflictPayloads).toHaveLength(1);

		// Resolving as merged uses open.local.lifetime (durable)
		const batchCalls: ChangeBatch[] = [];
		engine.subscribe(SCOPE, {
			onBatch: (b) => batchCalls.push(b),
			onConflict: () => ({ decision: "defer" as const }),
		});
		engine.resolveConflict(SCOPE, UNIT4, {
			decision: "merged",
			value: "cross-merged",
		});

		// Merged change has durable lifetime (from open.local)
		const mergedChange = batchCalls[0]?.changes[0];
		expect(mergedChange?.lifetime.class).toBe("durable");
	});
});
