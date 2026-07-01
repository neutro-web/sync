/**
 * T3-BC — tab close/reopen drives the ENGINE-LOCAL durable replay fork,
 * composed through a real BroadcastChannelTransport's pageshow/pagehide
 * lifecycle mapping onto onConnect/onDisconnect.
 * Gate: docs/gates/phase3-transports.md §T3-BC.
 *
 * Known-defect boundary (see gate + test/client/reconnect.test.ts B3):
 * `src/client/create-sync.ts`'s onConnect handler can never emit a replay
 * batch (B3 finding — lastCursor always sits at the engine's own tip by the
 * time onConnect fires). This test does NOT use createSync's fork. Instead
 * it builds a minimal, test-local "durable reconnect fork" directly on the
 * raw Engine + BroadcastChannelTransport seam: an onConnect handler that
 * calls `engine.changes(scope, lastCursorBeforeDisconnect)` and forwards
 * each batch via `transport.send()`. That proves the ENGINE-LOCAL
 * composition the gate describes — that BroadcastChannelTransport's
 * lifecycle mapping (pageshow/pagehide -> onConnect/onDisconnect) correctly
 * drives a durable-cursor replay when something wires it up — NOT that
 * create-sync.ts's own (broken) fork works, and NOT peer-pull recovery
 * (B recovering writes made only on A while B was closed) — that remains
 * the confirmed B3 defect, Phase 5, out of scope.
 */
import { expect, test } from "playwright/test";

const HARNESS = "http://localhost:59998/harness.html";
const DB_NAME = "ns-e2e-t3bc";
const SCOPE_KEY = "doc-t3bc";

test("T3-BC — reopened tab hydrates its own durable writes from IndexedDB; ephemeral does not survive", async ({
	browser,
}) => {
	const ctx = await browser.newContext();
	const page1 = await ctx.newPage();
	await page1.goto(HARNESS);

	await page1.evaluate(
		async ({ dbName, scopeKey }) => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
			const ns = (window as any).__ns;
			await new ns.IndexedDBStore(dbName).clear();
			const store = new ns.IndexedDBStore(dbName);
			const engine = new ns.Engine(ns.lww(), { store });
			const scope = ns.makeScope(scopeKey);
			await engine.hydrateScope(scope);
			await engine.apply({
				scope,
				changes: [
					{
						id: { value: "c1" },
						kind: "state",
						scope,
						unit: { key: "u1" },
						lifetime: { class: "durable" },
						value: "durable-val",
						version: ns.lww().mint(),
					},
					{
						id: { value: "eph1" },
						kind: "state",
						scope,
						unit: { key: "u2" },
						lifetime: ns.ephemeral(60000),
						value: "ephemeral-val",
						version: ns.lww().mint(),
					},
				],
			});
			await new Promise((r) => setTimeout(r, 100)); // flush IDB write
		},
		{ dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	await page1.close();

	// Real close+reopen: a brand-new page in the same context (same origin
	// storage, fresh JS heap — no shared in-memory state with page1).
	const page2 = await ctx.newPage();
	await page2.goto(HARNESS);

	const result = await page2.evaluate(
		async ({ dbName, scopeKey }) => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
			const ns = (window as any).__ns;
			const store = new ns.IndexedDBStore(dbName);
			const engine = new ns.Engine(ns.lww(), { store });
			const scope = ns.makeScope(scopeKey);
			await engine.hydrateScope(scope);

			// The engine hydrated from IndexedDB, giving us the persisted cursor
			// BEFORE any further durable writes land in this tab session. This is
			// the "cursor before disconnect" that a fresh tab starts from.
			const lastCursorBeforeDisconnect = engine.getCursor(scope);

			// Minimal, test-local durable reconnect fork wired onto a REAL
			// BroadcastChannelTransport: onConnect -> engine.changes(cursor) ->
			// transport.send(batch). This is exactly the composition T3-BC
			// verifies — driven by the transport's real pageshow lifecycle event,
			// not a stub.
			const channelName = `t3bc-fork-${scopeKey}`;
			const transport = new ns.BroadcastChannelTransport(channelName);
			const sent: unknown[] = [];
			const originalSend = transport.send.bind(transport);
			transport.send = async (batch: unknown) => {
				sent.push(batch);
				return originalSend(batch);
			};

			let onConnectFired = false;
			transport.onConnect(() => {
				onConnectFired = true;
				(async () => {
					for await (const batch of engine.changes(
						scope,
						lastCursorBeforeDisconnect,
					)) {
						await transport.send(batch);
					}
				})();
			});

			// A NEW durable change lands in THIS tab session (simulating a write
			// that happened after the cursor snapshot above but before the
			// transport's connect event fires) — this is what the fork must
			// replay. An ephemeral change is added alongside it to prove T3
			// (lifetime gates persistence/replay) holds across the composition.
			await engine.apply({
				scope,
				changes: [
					{
						id: { value: "c2" },
						kind: "state",
						scope,
						unit: { key: "u3" },
						lifetime: { class: "durable" },
						value: "post-reconnect-durable",
						version: ns.lww().mint(),
					},
					{
						id: { value: "eph2" },
						kind: "state",
						scope,
						unit: { key: "u4" },
						lifetime: ns.ephemeral(60000),
						value: "post-reconnect-ephemeral",
						version: ns.lww().mint(),
					},
				],
			});

			// Drive a REAL pageshow event — this is the tab-lifecycle mapping
			// BroadcastChannelTransport itself owns (src/transports/broadcast-
			// channel.ts:24-36), not a manual handler invocation.
			window.dispatchEvent(new Event("pageshow"));
			await new Promise((r) => setTimeout(r, 50));

			const snap = await engine.snapshot(scope);
			transport.close();

			return {
				onConnectFired,
				sentCount: sent.length,
				// biome-ignore lint/suspicious/noExplicitAny: reading unknown batch shape in test
				sentChangeIds: sent.flatMap((b: any) =>
					// biome-ignore lint/suspicious/noExplicitAny: reading unknown batch shape in test
					b.changes.map((c: any) => c.id.value),
				),
				snapChanges: snap.changes,
				cursorSeq: engine.getCursor(scope)._seq,
			};
		},
		{ dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	// The transport's real pageshow event drove onConnect, which drove the
	// durable reconnect fork.
	expect(result.onConnectFired).toBe(true);
	// Only the durable change added AFTER the pre-disconnect cursor was
	// replayed — the ephemeral change added at the same time was NOT
	// (engine.changes() only walks the durable log; T3).
	expect(result.sentCount).toBe(1);
	expect(result.sentChangeIds).toEqual(["c2"]);

	// Snapshot after hydration + the post-reconnect apply: both durable
	// changes are present (c1 hydrated from page1's persisted IndexedDB log,
	// c2 applied live in this session). eph2 is also present — it's held
	// in-memory in THIS engine instance's ephemeral state map, which is
	// expected (ephemeral state is visible for the lifetime of the session
	// it was written in). What matters for T3 is eph1: it was written in
	// page1's session and never persisted/replayed — it did NOT survive the
	// close/reopen, proving ephemeral state comes from snapshot (in-memory,
	// this-session-only), never from cursor-based replay/hydration.
	// biome-ignore lint/suspicious/noExplicitAny: reading unknown change shape in test
	const values = (result.snapChanges as any[]).map((c) => c.value).sort();
	expect(values).toEqual([
		"durable-val",
		"post-reconnect-durable",
		"post-reconnect-ephemeral",
	]);
	expect(values).not.toContain("ephemeral-val"); // eph1 did not survive reload
	// Only durable applies advance the persisted cursor (T3) — two durable
	// changes total across both sessions (c1, c2), regardless of the two
	// ephemeral changes also applied.
	expect(result.cursorSeq).toBe(2);

	await ctx.close();
});
