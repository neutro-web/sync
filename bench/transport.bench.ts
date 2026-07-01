/**
 * T7 — BroadcastChannel baseline numbers. CC/CI only (gate §T7).
 *
 * MEASUREMENT SEMANTICS:
 * - "cross-tab round-trip latency": in a single Playwright/Chromium
 *   context, time from calling transport.send() on channel A to channel
 *   B's receive() firing. Same-context (not cross-tab) BroadcastChannel
 *   still crosses the real browser IPC boundary the gate cares about —
 *   BroadcastChannel delivery is asynchronous and structured-clone-boxed
 *   regardless of same- vs. cross-tab, so this is a valid CC number for
 *   the channel primitive itself.
 * - Denominator: per single ChangeBatch containing exactly 1 Change.
 *
 * SANDBOX NUMBERS ARE INVALID — only Playwright/Chromium (CC/CI) numbers
 * are meaningful, same discipline as bench/persistence.bench.ts (D7).
 */
import { bench, describe } from "vitest";
import { BroadcastChannelTransport } from "../src/transports/broadcast-channel.ts";
import { DURABLE, makeChangeId, makeConflictUnit, makeScope } from "../src/core/types.ts";
import { lww } from "../src/strategies/index.ts";

function batch(n: number) {
	const scope = makeScope("s-bench-bc");
	return {
		scope,
		changes: [
			{
				id: makeChangeId(`bench-bc-${n}`),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: `v${n}`,
				version: lww().mint(),
			},
		],
	};
}

describe("T7 — BroadcastChannel baseline (CC/CI only)", () => {
	bench("cross-tab round-trip latency — 1-change batch (N=1)", async () => {
		const a = new BroadcastChannelTransport("bench-bc-latency");
		const b = new BroadcastChannelTransport("bench-bc-latency");
		await new Promise<void>((resolve) => {
			b.receive(() => resolve());
			a.send(batch(1));
		});
		a.close();
		b.close();
	});
});
