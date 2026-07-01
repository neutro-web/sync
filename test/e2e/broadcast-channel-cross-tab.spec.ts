/**
 * T2 — cross-tab delivery observed on real hardware. Gate: docs/gates/phase3-transports.md §T2.
 * Two real browser tabs (pages) in the same browser context, no shared JS
 * state between them — the only path between the two page globals is a real
 * BroadcastChannel.
 *
 * Deviation from the brief: the brief used `browser.newContext()` for each
 * peer. In real Chromium, BroadcastChannel is scoped to the storage
 * partition, and `browser.newContext()` creates a *separate* storage
 * partition per context (like separate browser profiles) — messages never
 * cross. Verified empirically: with two `newContext()`s, tab B never
 * receives tab A's onBatch at all. Two tabs (pages) within the *same*
 * context share a storage partition and do receive BroadcastChannel
 * messages — this is also the more faithful "two real tabs" setup, since
 * real end users opening two tabs of the same site share one browser
 * profile/partition, not two.
 */
import { expect, test } from "playwright/test";

const HARNESS = "http://localhost:59998/harness.html";

async function setupPeer(
	page: import("playwright/test").Page,
	channel: string,
) {
	await page.goto(HARNESS);
	await page.evaluate((ch) => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const ns = (window as any).__ns;
		const transport = new ns.BroadcastChannelTransport(ch);
		const client = ns.createSync({ transport });
		const doc = client.scope("doc-t2", { strategy: ns.lww() });
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc = doc;
	}, channel);
}

test("T2 — tab B's snapshot reflects tab A's durable write, channel-only path", async ({
	browser,
}) => {
	const ctx = await browser.newContext();
	const pageA = await ctx.newPage();
	const pageB = await ctx.newPage();

	await setupPeer(pageA, "t2-cross-tab");
	await setupPeer(pageB, "t2-cross-tab");

	await pageA.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.set("k1", "from-a");
	});

	await pageB.waitForFunction(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const snap = await (window as any).__doc.snapshot();
		return snap.length === 1;
	});

	const snapB = await pageB.evaluate(() =>
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.snapshot(),
	);
	expect(snapB).toHaveLength(1);
	expect(snapB[0].value).toBe("from-a");

	// Bidirectional: B → A
	await pageB.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		(window as any).__doc.set("k2", "from-b");
	});
	await pageA.waitForFunction(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: e2e harness bridge
		const snap = await (window as any).__doc.snapshot();
		return snap.length === 2;
	});

	await ctx.close();
});
