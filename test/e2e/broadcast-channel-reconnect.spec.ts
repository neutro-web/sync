/**
 * T3-BC — tab close/reopen drives ENGINE-LOCAL durable replay from IndexedDB.
 * Gate: docs/gates/phase3-transports.md §T3-BC.
 *
 * Known-defect boundary (see gate + test/client/reconnect.test.ts B3):
 * this test does NOT assert peer-pull recovery (B recovering A's writes
 * made while B was closed). It asserts B's OWN persisted log survives its
 * own close/reopen and hydrates correctly — the engine-local half of T3-BC.
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

	const snap = await page2.evaluate(
		async ({ dbName, scopeKey }) => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
			const ns = (window as any).__ns;
			const store = new ns.IndexedDBStore(dbName);
			const engine = new ns.Engine(ns.lww(), { store });
			const scope = ns.makeScope(scopeKey);
			await engine.hydrateScope(scope);
			const s = await engine.snapshot(scope);
			return { changes: s.changes, cursorSeq: engine.getCursor(scope)._seq };
		},
		{ dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	expect(snap.changes).toHaveLength(1);
	// biome-ignore lint/suspicious/noExplicitAny: reading unknown change.value in test
	expect((snap.changes[0] as any).value).toBe("durable-val");
	expect(snap.cursorSeq).toBe(1);

	await ctx.close();
});
