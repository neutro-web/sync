/**
 * IndexedDB-backed PersistenceStore.
 *
 * Schema:
 *   objectStore "changes": keyPath ["scopeKey", "seq"]
 *   objectStore "cursors": keyPath "scopeKey"
 */
import type {
	PersistenceRecord,
	PersistenceStore,
} from "../core/persistence.ts";
import type { Change } from "../core/types.ts";

const DB_VERSION = 1;

function openDB(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains("changes"))
				db.createObjectStore("changes", { keyPath: ["scopeKey", "seq"] });
			if (!db.objectStoreNames.contains("cursors"))
				db.createObjectStore("cursors", { keyPath: "scopeKey" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export class IndexedDBStore implements PersistenceStore {
	private readonly _dbName: string;
	private _db: IDBDatabase | null = null;

	constructor(dbName: string) {
		this._dbName = dbName;
	}

	private async _open(): Promise<IDBDatabase> {
		if (!this._db) this._db = await openDB(this._dbName);
		return this._db;
	}

	async appendChange(
		scopeKey: string,
		record: PersistenceRecord,
	): Promise<void> {
		const db = await this._open();
		const tx = db.transaction("changes", "readwrite");
		await idbReq(
			tx
				.objectStore("changes")
				.put({ scopeKey, seq: record.seq, change: record.change }),
		);
	}

	async readChanges(
		scopeKey: string,
		since?: number,
	): Promise<PersistenceRecord[]> {
		const db = await this._open();
		const tx = db.transaction("changes", "readonly");
		const lower: IDBValidKey =
			since !== undefined ? [scopeKey, since] : [scopeKey, 0];
		const upper: IDBValidKey = [scopeKey, Number.MAX_SAFE_INTEGER];
		const range = IDBKeyRange.bound(lower, upper, since !== undefined, false);
		const rows: PersistenceRecord[] = [];
		await new Promise<void>((resolve, reject) => {
			const req = tx.objectStore("changes").openCursor(range);
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) {
					resolve();
					return;
				}
				const row = cursor.value as {
					scopeKey: string;
					seq: number;
					change: Change;
				};
				rows.push({ change: row.change, seq: row.seq });
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
		return rows;
	}

	async writeCursor(scopeKey: string, seq: number): Promise<void> {
		const db = await this._open();
		const tx = db.transaction("cursors", "readwrite");
		await idbReq(tx.objectStore("cursors").put({ scopeKey, seq }));
	}

	async readCursor(scopeKey: string): Promise<number | null> {
		const db = await this._open();
		const tx = db.transaction("cursors", "readonly");
		const row = await idbReq<{ scopeKey: string; seq: number } | undefined>(
			tx.objectStore("cursors").get(scopeKey),
		);
		return row?.seq ?? null;
	}

	async clear(): Promise<void> {
		if (this._db) {
			this._db.close();
			this._db = null;
		}
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(this._dbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
			// onblocked means another connection is still open; onsuccess will still
			// fire once those connections close — so we just wait.
			req.onblocked = () => {
				/* wait for onsuccess */
			};
		});
	}
}
