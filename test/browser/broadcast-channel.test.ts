import { describe, expect, it, vi } from "vitest";
import {
	DURABLE,
	makeChangeId,
	makeConflictUnit,
	makeScope,
} from "../../src/core/types.ts";
import { lww } from "../../src/strategies/index.ts";
import { BroadcastChannelTransport } from "../../src/transports/broadcast-channel.ts";

function sampleBatch() {
	const scope = makeScope("s-bc");
	return {
		scope,
		changes: [
			{
				id: makeChangeId("c1"),
				kind: "state" as const,
				scope,
				unit: makeConflictUnit("u1"),
				lifetime: DURABLE,
				value: "hello",
				version: lww().mint(),
			},
		],
	};
}

describe("T1 — BroadcastChannelTransport, §7-conformant", () => {
	it("implements the five-method Transport surface", () => {
		const t = new BroadcastChannelTransport("t1-surface");
		expect(typeof t.send).toBe("function");
		expect(typeof t.receive).toBe("function");
		expect(typeof t.onConnect).toBe("function");
		expect(typeof t.onDisconnect).toBe("function");
		expect(typeof t.close).toBe("function");
		t.close();
	});

	it("send() resolves immediately (hand-off, not delivery) — postMessage has no ack", async () => {
		const t = new BroadcastChannelTransport("t1-handoff");
		const start = performance.now();
		await t.send(sampleBatch());
		// Hand-off should not block on anything beyond postMessage itself.
		expect(performance.now() - start).toBeLessThan(20);
		t.close();
	});

	it("two same-name channels: A's postMessage reaches B's receive()", async () => {
		const a = new BroadcastChannelTransport("t1-pair");
		const b = new BroadcastChannelTransport("t1-pair");
		const received = vi.fn();
		b.receive(received);

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toHaveBeenCalledTimes(1);
		expect(received.mock.calls[0][0].changes[0].id.value).toBe("c1");

		a.close();
		b.close();
	});

	it("close() calls channel.close() — no further receive callbacks fire", async () => {
		const a = new BroadcastChannelTransport("t1-close");
		const b = new BroadcastChannelTransport("t1-close");
		const received = vi.fn();
		b.receive(received);
		b.close();

		await a.send(sampleBatch());
		await new Promise((r) => setTimeout(r, 20));
		expect(received).not.toHaveBeenCalled();
		a.close();
	});
});
