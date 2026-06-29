import { describe, expect, test } from "vitest";
import { createSync } from "../../src/client/create-sync.ts";
import { ephemeral } from "../../src/core/types.ts";
import type { Change } from "../../src/core/types.ts";
import { lww, vectorClock } from "../../src/strategies/index.ts";
import { InProcessTransport } from "../../src/transports/in-process.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";

// ─── G2-3: Vanilla end-to-end sync ───────────────────────────────────────────

describe("G2-3: vanilla end-to-end sync", () => {
	test("durable VC change reaches B subscribe and B snapshot (direct transport)", async () => {
		const [tA, tB] = InProcessTransport.pair();
		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		// Ephemeral LWW presence scope
		const presenceA = syncA.scope("room:42/presence", {
			strategy: lww(),
			lifetime: ephemeral(5_000),
		});
		const presenceB = syncB.scope("room:42/presence", {
			strategy: lww(),
			lifetime: ephemeral(5_000),
		});

		// Durable vector-clock doc scope
		const docA = syncA.scope("doc:99", { strategy: vectorClock("g3a") });
		const docB = syncB.scope("doc:99", { strategy: vectorClock("g3b") });

		// B subscribes before A writes
		const bDocChanges: Change[][] = [];
		docB.subscribe((changes) => bDocChanges.push([...changes]));

		// A writes on both scopes
		presenceA.set("user:alice", { x: 10, y: 20 });
		docA.set("para:7", { text: "hello" });

		// InProcessTransport.pair() delivers synchronously; no drain needed
		expect(bDocChanges.length).toBeGreaterThan(0);
		expect(
			bDocChanges
				.flat()
				.some((c) => (c.value as { text: string }).text === "hello"),
		).toBe(true);

		// B durable snapshot reflects the doc change
		const docSnap = await docB.snapshot();
		expect(docSnap.length).toBeGreaterThan(0);
		expect(
			docSnap.some((c) => (c.value as { text: string }).text === "hello"),
		).toBe(true);

		// B ephemeral snapshot reflects the presence change
		const presSnap = await presenceB.snapshot();
		expect(presSnap.length).toBeGreaterThan(0);
		expect(
			presSnap.some((c) => {
				const v = c.value as { x: number; y: number };
				return v.x === 10 && v.y === 20;
			}),
		).toBe(true);

		syncA.close();
		syncB.close();
	});

	test("durable VC change converges under reorder + duplicate faults (ChannelSimulator)", async () => {
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();

		// Seed 42: deterministic reorder + duplicate faults; no drops so delivery is guaranteed
		const chanAB = new ChannelSimulator(42, {
			reorderRate: 0.3,
			duplicateRate: 0.2,
		});
		const chanBA = new ChannelSimulator(99, {
			reorderRate: 0.3,
			duplicateRate: 0.2,
		});

		tA.channelFn = (batch) => chanAB.enqueue(batch, (b) => tB._deliver(b));
		tB.channelFn = (batch) => chanBA.enqueue(batch, (b) => tA._deliver(b));

		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		const docA = syncA.scope("doc:fault", { strategy: vectorClock("fa") });
		const docB = syncB.scope("doc:fault", { strategy: vectorClock("fb") });

		const bChanges: Change[][] = [];
		docB.subscribe((changes) => bChanges.push([...changes]));

		docA.set("para", { text: "fault-tolerant" });

		// Drain until stable (duplicates may cause extra rounds)
		for (let i = 0; i < 10; i++) {
			const delivered = chanAB.drain() + chanBA.drain();
			if (delivered === 0) break;
		}

		expect(bChanges.length).toBeGreaterThan(0);
		expect(
			bChanges
				.flat()
				.some((c) => (c.value as { text: string }).text === "fault-tolerant"),
		).toBe(true);

		const snap = await docB.snapshot();
		expect(
			snap.some((c) => (c.value as { text: string }).text === "fault-tolerant"),
		).toBe(true);

		syncA.close();
		syncB.close();
	});
});

// ─── G2-4: Per-scope config isolation ────────────────────────────────────────

describe("G2-4: per-scope config isolation", () => {
	// Deterministic resolver: lexicographically higher value wins on both replicas
	const alphabetResolver4 = {
		resolve(c: import("../../src/core/types.ts").Conflict): import("../../src/core/types.ts").Resolution {
			const local = c.local.value as string;
			const remote = c.remote.value as string;
			return local >= remote
				? { decision: "take-local" as const }
				: { decision: "take-remote" as const };
		},
	};

	test("VC scope resolves concurrent via its resolver; LWW scope in same client never gets concurrent", async () => {
		// Buffer outbound batches so we control delivery timing
		const buffA: import("../../src/core/types.ts").ChangeBatch[] = [];
		const buffB: import("../../src/core/types.ts").ChangeBatch[] = [];
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();
		tA.channelFn = (batch) => buffA.push(batch);
		tB.channelFn = (batch) => buffB.push(batch);

		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		// VC scope: auto-resolver tracks whether it was invoked (proving resolver fired)
		let resolverInvokeCount = 0;
		const trackingResolver = {
			resolve(c: import("../../src/core/types.ts").Conflict): import("../../src/core/types.ts").Resolution {
				resolverInvokeCount++;
				return alphabetResolver4.resolve(c);
			},
		};

		syncA.scope("vc-scope", { strategy: vectorClock("vc-a"), resolver: trackingResolver });
		const vcB = syncB.scope("vc-scope", { strategy: vectorClock("vc-b"), resolver: trackingResolver });

		// LWW scope: manual mode to detect if onConflict ever fires (it must not)
		syncA.scope("lww-scope", { strategy: lww(0), manual: true });
		const lwwB = syncB.scope("lww-scope", { strategy: lww(1), manual: true });

		let lwwConflictCount = 0;
		lwwB.onConflict(() => {
			lwwConflictCount++;
		});

		// Both write to the same unit on each scope, independently (no cross-delivery yet)
		syncA.scope("vc-scope").set("shared", "from-A");
		vcB.set("shared", "from-B");
		syncA.scope("lww-scope").set("shared", "from-A");
		lwwB.set("shared", "from-B");

		// Deliver A's batches to B — both vc-scope and lww-scope batches arrive
		for (const b of buffA.splice(0)) tB._deliver(b);

		// VC scope: B received A's {_vec:{vc-a:1}} against its own {_vec:{vc-b:1}} → concurrent
		// ResolverPump fires → trackingResolver called → conflict resolved
		expect(resolverInvokeCount).toBeGreaterThan(0);

		// LWW scope: B received A's {_ts:1, _node:0} against its own {_ts:1, _node:1}
		// LWWClockStrategy.compare never returns "concurrent" → no onConflict fired
		expect(lwwConflictCount).toBe(0);

		// LWW scope has a clean winner in B's snapshot (node 1 > node 0 → B's value)
		const lwwSnap = await lwwB.snapshot();
		expect(lwwSnap.length).toBe(1);
		expect(lwwSnap[0]?.value).toBe("from-B");

		// VC scope resolved — B's snapshot has a value (not stuck open)
		const vcSnap = await vcB.snapshot();
		expect(vcSnap.length).toBe(1);
		// alphabetResolver: "from-B" > "from-A" → take-local on B → "from-B" wins on B
		expect(vcSnap[0]?.value).toBe("from-B");

		syncA.close();
		syncB.close();
	});

	test("two scopes in one client do not share strategy state", async () => {
		const [t] = InProcessTransport.pair();
		const sync = createSync({ transport: t });

		const s1 = sync.scope("scope-1", { strategy: lww(10) });
		const s2 = sync.scope("scope-2", { strategy: vectorClock("isolated") });

		const s1Changes: Change[][] = [];
		const s2Changes: Change[][] = [];
		s1.subscribe((c) => s1Changes.push([...c]));
		s2.subscribe((c) => s2Changes.push([...c]));

		s1.set("unit", "v1");
		s2.set("unit", "v2");

		expect(s1Changes.length).toBe(1);
		expect(s2Changes.length).toBe(1);
		// Changes stay in their own scope
		expect(s1Changes[0]?.[0]?.value).toBe("v1");
		expect(s2Changes[0]?.[0]?.value).toBe("v2");

		sync.close();
	});
});
