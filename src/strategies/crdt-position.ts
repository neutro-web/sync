/**
 * CRDTPositionStrategy — a position-ordered ClockStrategy.
 *
 * ## Scope boundary (decision-log 2026-06-30, Phase B / B1)
 * This is a position-ordered `ClockStrategy` sufficient to (a) exercise the
 * seq-position version space named in the seam contract's consumer map
 * (`rich text / canvas` row: CRDT position, `merged` resolver) and (b) prove
 * convergence on the existing harness. It is explicitly NOT a full production
 * sequence CRDT: no tombstone GC, no block-wise RGA encoding, no rich-text
 * document model, and no true between-two-neighbors fractional allocation
 * (the `ClockStrategy.mint(prev?: Version)` signature takes one reference
 * point, not a `(before, after)` pair, so genuine betweenness allocation
 * cannot be expressed at this seam — a real sequence CRDT needs a richer
 * insert primitive than `ClockStrategy` provides). A fuller sequence CRDT, if
 * ever needed, is a separate later gate.
 *
 * ## Version shape
 * `{ _path: readonly number[]; _node: string }`. `_path` is a Dewey-decimal-
 * style position path, compared lexicographically with "shorter prefix sorts
 * before its extension" (so `[0]` < `[0, 1]` < `[1]`) — this is the position
 * total order. `_node` is the originating instance's id, used only (a) to
 * distinguish a genuine same-position collision from an idempotent re-apply,
 * and (b) as deterministic input to `mergeVersions`'s tie-break tag.
 *
 * ## mint(prev?)
 * - With `prev`: appends a new, deeper segment to `prev._path` — the result
 *   always compares `"after"` `prev` (an extension always sorts after the
 *   prefix it extends). This is the normal "insert after a known position"
 *   case and is how real sequential inserts in a document would chain.
 * - Without `prev`: returns the canonical root path `[0]`. This is a
 *   deliberate simplification (see scope boundary): every "fresh, unanchored"
 *   mint — from ANY instance — lands at the same root position. This is what
 *   makes "two independently-minted versions at the same insertion point"
 *   (the genuine CRDT-position collision case) trivially reachable: two
 *   different replicas each calling `mint()` with no prior anchor naturally
 *   collide at `[0]`, exactly mirroring two users inserting at the same
 *   anchor in a real document.
 *
 * ## compare(a, b)
 * Lexicographic total order on DISTINCT paths (antisymmetric, transitive).
 * On an EXACTLY equal path: different `_node` → `"concurrent"` (genuine
 * collision — surfaced, not silently tie-broken, unlike LWW); identical
 * `_node` AND identical path → `"before"` (idempotent re-apply, matching the
 * convention used by `LWWClockStrategy`/`VectorClockStrategy`).
 *
 * ## mergeVersions(a, b)
 * Required — `concurrent` is reachable here, so `merged` resolutions need it
 * (mirrors `vector-clock.ts`). Produces `[...basePath, tagMin, tagMax]` where
 * `basePath` is whichever of `a._path`/`b._path` is NOT before the other
 * (their shared path, in the normal equal-path collision case) and
 * `tagMin`/`tagMax` are a symmetric, deterministic, sorted pair derived from
 * hashing `a._node`/`b._node` — NOT from `this._nodeId` of the calling
 * instance. This is the trap named in the 2026-06-29 merge decision
 * (decision-log): a tag derived from the CALLING instance's own node id would
 * make merge(a,b) differ across replicas (each appending its own identity),
 * breaking replica-identical convergence. Deriving the tag purely from the
 * two INPUT versions keeps `mergeVersions(a, b)` structurally identical
 * (hence `compare`-equal) no matter which replica computes it, and the
 * extension is always strictly after BOTH inputs (an extension of the
 * dominating path remains, by transitivity, after the dominated one too).
 *
 * Internal shape is strategy-owned and opaque to ns — only this file reads
 * inside.
 */

import type { ClockStrategy, Version } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Internal shape — opaque outside this module
// ---------------------------------------------------------------------------

interface CRDTPositionVersionInternals {
	readonly _path: readonly number[];
	readonly _node: string;
}

function asPos(v: Version): CRDTPositionVersionInternals {
	return v as unknown as CRDTPositionVersionInternals;
}

/**
 * Deterministic string -> non-negative integer hash (FNV-1a, 32-bit).
 * Used only to turn a node id into a comparable numeric tag for
 * `mergeVersions`'s tie-break — not a security hash, just a stable,
 * order-independent way to combine two node identities into a position tag.
 */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Lexicographic comparison of two position paths. "Shorter prefix sorts
 * before its extension": `[0]` < `[0, 1]`. Returns -1, 0, or 1.
 */
function comparePaths(a: readonly number[], b: readonly number[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		// biome-ignore lint/style/noNonNullAssertion: i < len <= a.length/b.length
		const ai = a[i]!;
		// biome-ignore lint/style/noNonNullAssertion: i < len <= a.length/b.length
		const bi = b[i]!;
		if (ai !== bi) return ai < bi ? -1 : 1;
	}
	if (a.length === b.length) return 0;
	return a.length < b.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// CRDTPositionStrategy
// ---------------------------------------------------------------------------

export class CRDTPositionStrategy implements ClockStrategy {
	private readonly _nodeId: string;
	/** Per-instance counter, used only to keep a single instance's chained
	 * `mint(prev)` extensions distinct from one another at the same depth. */
	private _seq = 0;

	constructor(nodeId: string) {
		this._nodeId = nodeId;
	}

	mint(prev?: Version): Version {
		this._seq++;
		if (prev === undefined) {
			// Fresh, unanchored insert — canonical root. Deliberately collides
			// with any other instance's unanchored mint (see file-level doc).
			return { _path: [0], _node: this._nodeId } as unknown as Version;
		}
		const prevPath = asPos(prev)._path;
		return {
			_path: [...prevPath, this._seq],
			_node: this._nodeId,
		} as unknown as Version;
	}

	compare(a: Version, b: Version): "before" | "after" | "concurrent" {
		const av = asPos(a);
		const bv = asPos(b);
		const cmp = comparePaths(av._path, bv._path);
		if (cmp < 0) return "before";
		if (cmp > 0) return "after";
		// Equal path.
		if (av._node === bv._node) return "before"; // identical token — idempotent re-apply
		return "concurrent"; // genuine same-position collision from independent origins
	}

	mergeVersions(a: Version, b: Version): Version {
		const av = asPos(a);
		const bv = asPos(b);
		const cmp = comparePaths(av._path, bv._path);
		// basePath: whichever path is not-before the other. On the normal
		// (equal-path) collision case this is just the shared path; the
		// branches below also handle an unequal-path pair correctly, by
		// extending the dominating side.
		const basePath = cmp <= 0 ? bv._path : av._path;
		const hashA = fnv1a(av._node);
		const hashB = fnv1a(bv._node);
		const tagMin = Math.min(hashA, hashB);
		const tagMax = Math.max(hashA, hashB);
		return {
			_path: [...basePath, tagMin, tagMax],
			// Merge tag is symmetric across both inputs' identities, never the
			// calling instance's own — see file-level doc on the increment trap.
			_node: `merged:${[av._node, bv._node].sort().join(":")}`,
		} as unknown as Version;
	}
}
