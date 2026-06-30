/**
 * Phase B gate test — Group B3 (G2-6d: client T3 durable-fork reconnect test).
 * Gate file: docs/gates/phaseB-sandbox-gaps.md
 *
 * ## Status: FINDING, NOT CLOSED
 *
 * B3-1 set out to write a test that fires `transport.onConnect()` for real
 * (not the pre-existing `tB._deliver()` workaround in
 * `test/client/create-sync.test.ts`'s "G2-6d" describe block) and asserts
 * that the client's durable replay-from-cursor fork recovers changes a peer
 * missed during a disconnect.
 *
 * Executing that test (not just reading the code) surfaces a confirmed
 * defect: **the durable replay branch in `create-sync.ts`'s
 * `transport.onConnect()` handler can never replay anything, under any
 * sequence of events.**
 *
 * Root cause: `entry.lastCursor` is updated synchronously and
 * unconditionally inside the SAME `onBatch` callback that is the only path
 * by which a durable change enters `entry.engine`'s durable log — for both
 * locally-written changes (`set()`/`do()`) and remotely-received ones
 * (`transport.receive` -> `engine.apply`). There is no code path where the
 * engine's cursor advances without `entry.lastCursor` advancing in the same
 * synchronous step. Consequently, at the moment `onConnect` fires,
 * `entry.lastCursor` is ALWAYS exactly equal to `entry.engine.getCursor(scope)`,
 * so `entry.engine.changes(entry.scopeObj, entry.lastCursor)` always yields
 * zero batches — there is never a window where `lastCursor` lags the log it
 * is meant to checkpoint.
 *
 * A second, independent problem: even if `lastCursor` DID lag, the mechanism
 * as designed is a self-republish (broadcast) of THIS engine's OWN durable
 * log to the transport — there is no request/pull seam by which a
 * reconnecting client asks a peer for what IT (the peer) holds. So the
 * literal B3-1 scenario (B missed A's writes; B reconnects; B recovers A's
 * writes) cannot be solved by B's own onConnect handler under ANY lastCursor
 * semantics — only by the SENDER (A) successfully re-publishing on ITS OWN
 * reconnect, which requires A's `lastCursor` to track "confirmed delivered to
 * this peer," not "durably accepted into my own log." That is
 * delivery-above-transport territory (seam contract §7), already named as
 * Phase 5 in the decision log ("transport.send retry/backpressure/ack").
 *
 * This is NOT the "persistent cursor" finding the gate file anticipated
 * ("If the test cannot be written without a persistent cursor, that is a
 * finding to surface, not to silently fix") — persistence is irrelevant
 * here; this reproduces in a single in-memory process with no restart
 * involved. Per AGENTS.md halt-at-an-undecided-design-gate: fixing this
 * requires deciding WHEN `lastCursor` should advance (tied to confirmed
 * send/delivery, not durable accept) and/or adding an explicit pull-based
 * catch-up seam — both are design decisions outside B3's scope as written,
 * and both touch the §7 delivery-above-transport boundary already deferred
 * to Phase 5. Not invented or silently patched here.
 *
 * The tests below are a CHARACTERIZATION of current, verified behavior (kept
 * green deliberately, so this finding has a regression trip-wire instead of
 * silently rotting) — not a passing closure of G2-6d. See the decision-log
 * patch text in the session's final report for the proposed Current-State
 * update (G2-6d does not close; a more specific successor gate is opened).
 */

import { describe, expect, test } from "vitest";
import { createSync } from "../../src/client/create-sync.ts";
import type { ChangeBatch } from "../../src/core/types.ts";
import { vectorClock } from "../../src/strategies/index.ts";
import { InProcessTransport } from "../../src/transports/in-process.ts";

describe("B3-1 · onConnect durable fork — finding, not closure", () => {
	test("firing transport.onConnect() executes the durable-replay branch without throwing", async () => {
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();
		tA.channelFn = (b) => tB._deliver(b);
		tB.channelFn = (b) => tA._deliver(b);

		const syncA = createSync({ transport: tA });
		const docA = syncA.scope("doc-b3", { strategy: vectorClock("b3-a") });

		const syncB = createSync({ transport: tB });
		const docB = syncB.scope("doc-b3", { strategy: vectorClock("b3-b") });

		// B accumulates durable changes (own cursor advances) before any
		// onConnect fires.
		docB.set("k1", "v1");
		docB.set("k2", "v2");

		// Confirm the branch runs to completion with no thrown error — proves
		// the code path executes (this part of B3-1 IS satisfied).
		expect(() => {
			tB._setConnected(false);
			tB._setConnected(true);
		}).not.toThrow();

		syncA.close();
		syncB.close();
	});

	test("FINDING: onConnect's durable replay never emits a batch — lastCursor always equals the engine's own cursor by the time onConnect fires", async () => {
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();
		tA.channelFn = (b) => tB._deliver(b);
		tB.channelFn = (b) => tA._deliver(b);

		const syncA = createSync({ transport: tA });
		const docA = syncA.scope("doc-b3-finding", {
			strategy: vectorClock("b3f-a"),
		});

		const syncB = createSync({ transport: tB });
		const docB = syncB.scope("doc-b3-finding", {
			strategy: vectorClock("b3f-b"),
		});

		// B writes durable changes locally — the most favorable case for the
		// replay branch to have something to replay (B's own log is non-empty).
		docB.set("k1", "v1");
		docB.set("k2", "v2");

		// Capture everything B's transport sends during the onConnect window —
		// this is exactly what the durable-replay branch would forward.
		const sentByB: ChangeBatch[] = [];
		tB.channelFn = (b) => {
			sentByB.push(b);
		};

		tB._setConnected(false);
		tB._setConnected(true); // fires B's onConnect -> triggers the replay branch

		// Let the async IIFE inside onConnect run to completion.
		await new Promise((r) => setTimeout(r, 10));

		// CONFIRMED FINDING: zero batches sent. entry.lastCursor was already at
		// the tip of B's own durable log (updated synchronously in onBatch when
		// k1/k2 were accepted) before onConnect ever fired, so
		// engine.changes(scope, lastCursor) has nothing left to yield.
		expect(sentByB).toHaveLength(0);

		syncA.close();
		syncB.close();
	});

	test("FINDING: B cannot recover A's writes that landed only on A during B's disconnect, even with onConnect firing on both sides", async () => {
		const tA = new InProcessTransport();
		const tB = new InProcessTransport();
		tA.channelFn = (b) => tB._deliver(b);
		tB.channelFn = (b) => tA._deliver(b);

		const syncA = createSync({ transport: tA });
		const docA = syncA.scope("doc-b3-recover", {
			strategy: vectorClock("b3r-a"),
		});

		const syncB = createSync({ transport: tB });
		const docB = syncB.scope("doc-b3-recover", {
			strategy: vectorClock("b3r-b"),
		});

		// Connected: A's writes reach B normally.
		docA.set("k1", "v1");
		expect((await docB.snapshot()).length).toBe(1);

		// Disconnect B: A's sends to B are now buffered, not delivered (this is
		// the actual blocking mechanism — InProcessTransport's _setConnected
		// does not gate delivery on its own; see in-process.ts).
		tA.channelFn = () => {}; // A's sends vanish — simulates a cut wire
		tB._setConnected(false);

		// More durable changes land on A while B is "offline" — B never
		// receives them.
		docA.set("k2", "v2");
		docA.set("k3", "v3");
		expect((await docB.snapshot()).length).toBe(1); // B still missing k2/k3

		// Reconnect: restore real delivery and fire onConnect on BOTH sides —
		// the literal B3-1 setup ("onConnect() is fired") does not specify
		// which side, so both are exercised here to be exhaustive.
		tA.channelFn = (b) => tB._deliver(b);
		tB.channelFn = (b) => tA._deliver(b);
		tA._setConnected(false);
		tA._setConnected(true); // A's onConnect: replays FROM A's lastCursor
		tB._setConnected(true); // B's onConnect: replays FROM B's lastCursor

		await new Promise((r) => setTimeout(r, 10));

		// CONFIRMED FINDING: B still does not have k2/k3. Neither side's
		// onConnect handler can recover them: A's lastCursor already advanced
		// past k2/k3 when they were originally (vacuously) "sent" to the void,
		// so A's own replay-from-lastCursor yields nothing; B's own log never
		// had them to begin with, so B's replay-from-its-own-lastCursor is
		// replaying the wrong engine's data even in principle.
		expect((await docB.snapshot()).length).toBe(1);

		syncA.close();
		syncB.close();
	});
});
