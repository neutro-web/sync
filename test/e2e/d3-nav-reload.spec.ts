/**
 * D3 — Navigation-reload durability: IndexedDB data survives a real page.reload().
 *
 * Approach: raw IDB calls via page.evaluate() — no Engine import needed.
 * The Engine's hydrateScope reading from IDB is verified by the D2 browser
 * tests. The property this gate closes is that IDB itself survives a genuine
 * browser navigation reload (JS heap cleared). page.reload() is the only way
 * to prove this; fresh-instance simulation does not qualify.
 *
 * Schema mirrors IndexedDBStore (src/persistence/idb-store.ts):
 *   objectStore "changes" — keyPath ["scopeKey", "seq"]
 *   objectStore "cursors" — keyPath "scopeKey"
 */
import { expect, test } from "playwright/test";

const DB_NAME = "ns-e2e-d3-nav-reload";
const SCOPE_KEY = "scope-d3";

/** Inline IDB helpers injected into the page via evaluate(). */
const IDB_HELPERS = /* js */ `
  function openDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("changes"))
          db.createObjectStore("changes", { keyPath: ["scopeKey", "seq"] });
        if (!db.objectStoreNames.contains("cursors"))
          db.createObjectStore("cursors", { keyPath: "scopeKey" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteDB(name) {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => { /* wait */ };
    });
  }

  async function seedDB(dbName, scopeKey, changes) {
    const db = await openDB(dbName);
    const tx = db.transaction(["changes", "cursors"], "readwrite");
    for (const c of changes) {
      await idbReq(tx.objectStore("changes").put({ scopeKey, seq: c.seq, change: c.change }));
    }
    await idbReq(tx.objectStore("cursors").put({ scopeKey, seq: changes.length }));
    db.close();
  }

  async function readDB(dbName, scopeKey) {
    const db = await openDB(dbName);
    const tx = db.transaction(["changes", "cursors"], "readonly");
    const lower = [scopeKey, 0];
    const upper = [scopeKey, Number.MAX_SAFE_INTEGER];
    const range = IDBKeyRange.bound(lower, upper, false, false);
    const rows = await new Promise((resolve, reject) => {
      const result = [];
      const req = tx.objectStore("changes").openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(result); return; }
        result.push({ seq: cursor.value.seq, value: cursor.value.change.value });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    const cursor = await idbReq(tx.objectStore("cursors").get(scopeKey));
    db.close();
    return { rows, cursorSeq: cursor ? cursor.seq : null };
  }
`;

const SEED_CHANGES = [
	{ seq: 1, change: { id: "c1", kind: "state", value: "alpha" } },
	{ seq: 2, change: { id: "c2", kind: "state", value: "beta" } },
	{ seq: 3, change: { id: "c3", kind: "state", value: "gamma" } },
];

test("D3 — IndexedDB survives page.reload() (real navigation, heap cleared)", async ({
	page,
}) => {
	// 1. Navigate to a blank page that has IndexedDB access.
	//    about:blank blocks IDB; serve a minimal page via route interception.
	await page.route("**/d3-blank", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body></body></html>",
		}),
	);
	await page.goto("http://localhost:59999/d3-blank");

	// 2. Clear any leftover DB from a prior run, then seed 3 durable changes.
	await page.evaluate(
		async ({ helpers, dbName, scopeKey }) => {
			// biome-ignore lint/security/noGlobalEval: intentional — injecting IDB helpers into the page
			eval(helpers);
			// @ts-expect-error: deleteDB defined in eval'd scope
			await deleteDB(dbName);
			// @ts-expect-error: seedDB defined in eval'd scope
			await seedDB(dbName, scopeKey, [
				{ seq: 1, change: { id: "c1", kind: "state", value: "alpha" } },
				{ seq: 2, change: { id: "c2", kind: "state", value: "beta" } },
				{ seq: 3, change: { id: "c3", kind: "state", value: "gamma" } },
			]);
		},
		{ helpers: IDB_HELPERS, dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	// 3. REAL browser navigation reload — clears the JS heap.
	//    This is the key action that proves D3: data must survive this.
	await page.reload();

	// 4. Post-reload: read IDB back in the fresh page context.
	const result = await page.evaluate(
		async ({ helpers, dbName, scopeKey }) => {
			// biome-ignore lint/security/noGlobalEval: intentional — injecting IDB helpers into the page
			eval(helpers);
			// @ts-expect-error: readDB defined in eval'd scope
			return readDB(dbName, scopeKey);
		},
		{ helpers: IDB_HELPERS, dbName: DB_NAME, scopeKey: SCOPE_KEY },
	);

	// 5. Assert: all 3 changes survived the reload and cursor is correct.
	expect(result.rows).toHaveLength(SEED_CHANGES.length);
	expect(result.rows[0]).toMatchObject({ seq: 1, value: "alpha" });
	expect(result.rows[1]).toMatchObject({ seq: 2, value: "beta" });
	expect(result.rows[2]).toMatchObject({ seq: 3, value: "gamma" });
	expect(result.cursorSeq).toBe(SEED_CHANGES.length);

	// 6. Cleanup: remove test DB.
	await page.evaluate(
		async ({ helpers, dbName }) => {
			// biome-ignore lint/security/noGlobalEval: intentional — injecting IDB helpers into the page
			eval(helpers);
			// @ts-expect-error: deleteDB defined in eval'd scope
			await deleteDB(dbName);
		},
		{ helpers: IDB_HELPERS, dbName: DB_NAME },
	);
});
