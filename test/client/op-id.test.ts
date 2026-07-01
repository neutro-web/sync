/**
 * NF-1 — consumer-supplied op id (`WriteOpts.opId`).
 * Gate: docs/gates/nf1-opid-gate.md.
 *
 * Origin: nf integration spike (2026-06-30) Finding 1 — `do()` minted op ids
 * internally, so a consumer could not make an op idempotent across
 * redelivery; a redelivered op double-applied. `opId` lets a consumer supply
 * a stable id so `ns`'s existing dedup-by-id collapses redelivery.
 */
import { describe, expect, test } from "vitest";
import { createSync } from "../../src/client/create-sync.ts";
import type { Change } from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";
import { InProcessTransport } from "../../src/transports/in-process.ts";
import { ChannelSimulator } from "../harness/channel-simulator.ts";

describe("NF-1: consumer-supplied op id", () => {
	test("NF1-1 · stable opId dedups redelivery", () => {
		const [tA, tB] = InProcessTransport.pair();
		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		const docA = syncA.scope("doc:nf1-1", { strategy: lww(1) });
		const docB = syncB.scope("doc:nf1-1", { strategy: lww(2) });

		let count = 0;
		docB.subscribe((changes) => {
			count += changes.filter((c) => c.kind === "op").length;
		});

		docA.do("submit", { p: 1 }, { opId: "A:submit:1" });
		docA.do("submit", { p: 1 }, { opId: "A:submit:1" });

		expect(count).toBe(1);

		syncA.close();
		syncB.close();
	});

	test("NF1-2 · no opId preserves auto-mint (back-compat)", () => {
		const [tA, tB] = InProcessTransport.pair();
		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		const docA = syncA.scope("doc:nf1-2", { strategy: lww(1) });
		const docB = syncB.scope("doc:nf1-2", { strategy: lww(2) });

		let count = 0;
		docB.subscribe((changes) => {
			count += changes.filter((c) => c.kind === "op").length;
		});

		docA.do("other", { q: 9 });
		docA.do("other", { q: 9 });

		expect(count).toBe(2);

		syncA.close();
		syncB.close();
	});

	test("NF1-3 · opId collision drops the second op (documented consequence)", () => {
		const [tA, tB] = InProcessTransport.pair();
		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		const docA = syncA.scope("doc:nf1-3", { strategy: lww(1) });
		const docB = syncB.scope("doc:nf1-3", { strategy: lww(2) });

		const applied: Change[] = [];
		docB.subscribe((changes) => {
			applied.push(...changes.filter((c) => c.kind === "op"));
		});

		docA.do("x", { v: 1 }, { opId: "dup" });
		docA.do("x", { v: 2 }, { opId: "dup" });

		expect(applied).toHaveLength(1);
		expect((applied[0].value as { v: number }).v).toBe(1);

		syncA.close();
		syncB.close();
	});

	test("NF1-4 · opId redelivery converges under faults (2 replicas)", () => {
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();

		// Seed 7: drop + duplicate faults; deterministic.
		const chanAB = new ChannelSimulator(7, {
			dropRate: 0.3,
			duplicateRate: 0.2,
		});
		const chanBA = new ChannelSimulator(13, {
			dropRate: 0.3,
			duplicateRate: 0.2,
		});

		tA.channelFn = (batch) => chanAB.enqueue(batch, (b) => tB._deliver(b));
		tB.channelFn = (batch) => chanBA.enqueue(batch, (b) => tA._deliver(b));

		const syncA = createSync({ transport: tA });
		const syncB = createSync({ transport: tB });

		const docA = syncA.scope("doc:nf1-4", { strategy: lww(1) });
		const docB = syncB.scope("doc:nf1-4", { strategy: lww(2) });

		const applied: Change[] = [];
		docB.subscribe((changes) => {
			applied.push(...changes.filter((c) => c.kind === "op"));
		});

		// Capture the outbound batch A's engine sends for the op. A's own
		// engine dedups by ChangeId (T1), so calling docA.do() again with the
		// same opId is a local no-op and sends nothing new — exactly the
		// property opId is meant to give the CONSUMER for its own dedup, not
		// a way to force a resend through the client. The re-drive that
		// actually needs testing here is at the transport/channel level: the
		// consumer (or a future Phase-5 retry layer) resends the SAME raw
		// batch until the peer has it — mirroring the nf spike's proven
		// re-drive pattern, now carrying a stable, dedup-safe opId instead of
		// an in-value __idem hack.
		let outbound: Parameters<typeof tA.send>[0] | undefined;
		const originalSend = tA.send.bind(tA);
		tA.send = (batch) => {
			outbound ??= batch;
			return originalSend(batch);
		};

		docA.do("submit", { p: 1 }, { opId: "A:submit:nf1-4" });
		for (let j = 0; j < 10; j++) {
			const delivered = chanAB.drain() + chanBA.drain();
			if (delivered === 0) break;
		}

		// Re-drive the same raw batch (same opId, same ChangeId) directly
		// over the transport until B has observed it.
		for (let i = 0; i < 20 && applied.length === 0; i++) {
			if (outbound) tA.send(outbound);
			for (let j = 0; j < 10; j++) {
				const delivered = chanAB.drain() + chanBA.drain();
				if (delivered === 0) break;
			}
		}

		expect(applied).toHaveLength(1);
		expect((applied[0].value as { p: number }).p).toBe(1);

		syncA.close();
		syncB.close();
	});
});
