/**
 * @neutro/sync — Seam Contract types (v1.1)
 *
 * Derived from docs/seam-contract.md §1–§8. This file is the TypeScript
 * expression of the frozen seam. Nothing here is domain-specific.
 *
 * Brands use `declare const` unique symbols — type-level only, erased at runtime.
 * Factory helpers (`makeScope`, `makeCursor`, …) construct runtime objects cast
 * to their branded types.
 */

// ---------------------------------------------------------------------------
// § 8  Shared opaque tokens
// ---------------------------------------------------------------------------

declare const ChangeIdBrand: unique symbol;
export interface ChangeId {
	readonly [ChangeIdBrand]: true;
	readonly value: string;
}

declare const ScopeBrand: unique symbol;
/** Opaque partition key: document id, room, collection, key-prefix, etc. */
export interface Scope {
	readonly [ScopeBrand]: true;
	readonly key: string;
}

declare const ConflictUnitBrand: unique symbol;
/** ns compares units for equality/dedup only; never interprets structure. */
export interface ConflictUnit {
	readonly [ConflictUnitBrand]: true;
	readonly key: string;
}

// ---------------------------------------------------------------------------
// § 2  Version — strategy-owned, opaque to ns
// ---------------------------------------------------------------------------

declare const VersionBrand: unique symbol;
/**
 * "Is my copy of unit X newer than yours?" — per-unit comparison token.
 * Strategy-owned and opaque to ns. Carried as a black box on a Change.
 * ns never reads inside it; it only calls ClockStrategy.compare().
 */
export interface Version {
	readonly [VersionBrand]: true;
}

// ---------------------------------------------------------------------------
// § 2  Cursor — ns-owned, concrete
// ---------------------------------------------------------------------------

declare const CursorBrand: unique symbol;
/**
 * "Where am I in this feed?" — ns-owned and concrete.
 * Opaque to consumers (never constructed by them), structured for the engine.
 * Monotonic per scope. Only DURABLE changes advance it (T3).
 */
export interface Cursor {
	readonly [CursorBrand]: true;
	readonly scope: Scope;
	/** Monotonic durable-change sequence number. Implementation detail, not part of the public seam. */
	readonly _seq: number;
}

// ---------------------------------------------------------------------------
// § 3  Lifetime — T3 fork selector
// ---------------------------------------------------------------------------

export type Lifetime =
	| { readonly class: "durable" }
	| { readonly class: "ephemeral"; readonly ttlMs: number };

// ---------------------------------------------------------------------------
// § 1  Change — T1
// ---------------------------------------------------------------------------

interface ChangeBase {
	readonly id: ChangeId;
	readonly scope: Scope;
	readonly unit: ConflictUnit;
	readonly lifetime: Lifetime;
	readonly value: unknown;
}

/**
 * "field X is now Y". Idempotent, latest-wins-able.
 * Preset: { idempotent: true, replay: "latest-only", ordering: "per-key" }
 */
export interface StateChange extends ChangeBase {
	readonly kind: "state";
	/** Strategy-owned comparison token. Opaque to ns. Drives conflict detection. */
	readonly version: Version;
}

/**
 * "do X". Intent; must apply exactly once; order-sensitive.
 * Preset: { idempotent: false, replay: "all", ordering: "total" }
 * `version` present only for op-transport-with-local-fold consumers.
 */
export interface OpChange extends ChangeBase {
	readonly kind: "op";
	readonly version?: Version;
}

export type Change = StateChange | OpChange;

/** A Change that carries a version — can participate in conflict detection. */
export type VersionedChange =
	| StateChange
	| (OpChange & { readonly version: Version });

// ---------------------------------------------------------------------------
// § 4  ChangeBatch & Snapshot
// ---------------------------------------------------------------------------

export interface ChangeBatch {
	readonly scope: Scope;
	readonly changes: readonly Change[];
	/** Cursor AFTER applying this batch. Reflects only durable changes (T3). */
	readonly cursor?: Cursor;
	/** When true, ns guarantees the batch is all-or-nothing. */
	readonly atomic?: boolean;
}

export interface Snapshot {
	readonly scope: Scope;
	readonly changes: readonly Change[];
}

// ---------------------------------------------------------------------------
// § 4  Feed — symmetric seam
// ---------------------------------------------------------------------------

export interface Feed {
	/** OUT — durable replay. Emits durable changes since `cursor` in causal order per scope (T5). */
	changes(scope: Scope, since: Cursor | null): AsyncIterable<ChangeBatch>;
	/** OUT — current-state-on-subscribe. Used for ephemeral reconnect and memoryless-transport durable. */
	snapshot(scope: Scope): Promise<Snapshot>;
	/** IN — apply a batch from a peer/transport. */
	apply(batch: ChangeBatch): Promise<void>;
}

// ---------------------------------------------------------------------------
// § 5  Conflict & Resolver — T4
// ---------------------------------------------------------------------------

export interface Conflict<V = unknown> {
	readonly unit: ConflictUnit;
	readonly local: VersionedChange;
	readonly remote: VersionedChange;
	readonly base?: V;
	readonly scope: Scope;
}

export type Resolution<V = unknown> =
	| { readonly decision: "take-local" }
	| { readonly decision: "take-remote" }
	| { readonly decision: "merged"; readonly value: V }
	| { readonly decision: "defer" };

export interface Resolver<V = unknown> {
	resolve(conflict: Conflict<V>): Resolution<V> | Promise<Resolution<V>>;
}

// ---------------------------------------------------------------------------
// § 2  ClockStrategy — T2
// ---------------------------------------------------------------------------

export interface ClockStrategy {
	mint(prev?: Version): Version;
	compare(a: Version, b: Version): "before" | "after" | "concurrent";
	/**
	 * Return a version that causally dominates BOTH `a` and `b` and is
	 * `compare`-equal across all replicas that call `mergeVersions(a, b)`.
	 * Required by the `merged` resolution arm; omit on strategies where
	 * `compare` never returns `"concurrent"` (e.g. LWW).
	 * Seam contract v1.1 addition.
	 */
	mergeVersions?(a: Version, b: Version): Version;
}

// ---------------------------------------------------------------------------
// § 6  Scope & ScopeRouter — T5
// ---------------------------------------------------------------------------

export interface Subscription {
	unsubscribe(): void;
}

export interface ScopeRouter {
	subscribe(
		scope: Scope,
		handlers: {
			onBatch(batch: ChangeBatch): void;
			onConflict(conflict: Conflict): Resolution | Promise<Resolution>;
		},
	): Subscription;
}

// ---------------------------------------------------------------------------
// § 7  Transport
// ---------------------------------------------------------------------------

export interface Transport {
	/** Resolves on hand-off to the carrier, NOT on ack (mandate: local progress never blocks). */
	send(batch: ChangeBatch): Promise<void>;
	receive(onBatch: (batch: ChangeBatch) => void): void;
	onConnect(handler: () => void): void;
	onDisconnect(handler: () => void): void;
	close(): void;
}

// ---------------------------------------------------------------------------
// Runtime factory helpers
// (Brand symbols are type-level only; factories cast plain objects to branded types.)
// ---------------------------------------------------------------------------

export function makeChangeId(value: string): ChangeId {
	return { value } as ChangeId;
}

export function makeScope(key: string): Scope {
	return { key } as Scope;
}

export function makeConflictUnit(key: string): ConflictUnit {
	return { key } as ConflictUnit;
}

export function makeCursor(scope: Scope, seq: number): Cursor {
	return { scope, _seq: seq } as Cursor;
}

export const DURABLE: Lifetime = Object.freeze({
	class: "durable",
}) as Lifetime;

export function ephemeral(ttlMs: number): Lifetime {
	return { class: "ephemeral", ttlMs };
}
