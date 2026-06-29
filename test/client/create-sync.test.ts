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
