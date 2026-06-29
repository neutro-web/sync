# ns Phase 3 Gate — `merged` Resolution + `ClockStrategy.mergeVersions`

> Written before code per AGENTS.md discipline.
> Design basis: `docs/design/merge-resolution.md` (Q-C crux: max-only join).
> Implementation brief: `impl-brief-mergeversions.draft.md`.
> All items must be independently failable (a pass that cannot fail proves nothing).

## Gate items

**C1 — Contract surface.**
`ClockStrategy` in `src/core/types.ts` declares `mergeVersions?(a: Version, b: Version): Version`
as an optional method. `tsc --strict` is clean.
*Evidence:* `grep mergeVersions src/core/types.ts` present + `pnpm typecheck` exits 0.
*Fails if:* method missing, or non-optional (would force LWW to implement it), or `tsc` errors.

**C2 — `VectorClockStrategy.mergeVersions` correctness.**
Implementation: element-wise max of both `_vec` records, no local-slot increment.
*Evidence:* unit tests in `test/engine/phase3-merge-resolution.test.ts` —
- `compare(merge(a,b), a) === "after"` (merged dominates a).
- `compare(merge(a,b), b) === "after"` (merged dominates b).
- `compare(merge(a,b), merge(b,a)) === "before"` (order-independent; logical equality via `compare`).
- `compare(a, merge(a,b)) === "before"` (redelivered input is skipped).
- `compare(mint(merge(a,b)), merge(a,b)) === "after"` (post-merge write dominates).
- N-way: `merge(merge(a,b), c)` dominates `a`, `b`, `c`.
*Fails if:* any assertion returns `concurrent`, or the merge increments a local slot.

**C3 — LWW omits `mergeVersions`.**
`LWWClockStrategy` does not implement `mergeVersions`. `tsc --strict` clean (optional method).
*Evidence:* `grep mergeVersions src/strategies/lww.ts` → no match + `pnpm typecheck` exits 0.
*Fails if:* LWW ships a stub or `tsc` requires it.

**C4 — Engine `merged` arm (`resolveConflict`).**
The throw is replaced. Single-engine test: a `merged` resolution writes the merged value to the
confirmed map, advances cursor iff durable, fires `onBatch` once, clears the open conflict.
*Evidence:* unit test in `test/engine/phase3-merge-resolution.test.ts`.
*Fails if:* throw remains; or merged value not in snapshot; or cursor advances on ephemeral;
or conflict stays open; or `onBatch` not fired.

**C5 — Guard: `merged` under a strategy without `mergeVersions`.**
Engine on a strategy that lacks `mergeVersions`; `resolveConflict(..., {decision:"merged", value})`
throws the precise error string ("strategy does not implement mergeVersions") before mutating any map.
*Evidence:* test verifies the throw AND that `openConflicts` still contains the entry after the throw.
*Fails if:* silent drop, or partial mutation before throw, or wrong error message.

**C6 — ≥2-replica convergence; merged value does NOT re-conflict on redelivery.**
2 engines (nodes A, B), `VectorClockStrategy` each, one scope, one unit, `ChannelSimulator`
with fault injection (drop/reorder/duplicate). Both write concurrently → `concurrent` detected.
A deterministic symmetric resolver returns `{decision:"merged", value:"merged-AB"}`.
Drain to quiescence. Assert:
- both `snapshot(scope)` for the unit are equal (converged on "merged-AB").
- the unit's confirmed version dominates both original input versions on both engines.
- duplicate redelivery of an original input does NOT re-open a conflict (`openConflicts` empty).
- 3-replica variant: isolate B, A+C merge and converge, reconnect B → all 3 converge on merged
  value, no lingering open conflict.
*Fails if:* snapshots diverge; OR merged version is `concurrent` with the other replica's merged
version (would happen under max-then-increment, not max-only → RED); OR redelivery re-opens conflict.

**C7 — Both gates green.**
`pnpm typecheck` (tsc --strict) exits 0 AND `pnpm test` (vitest run) all pass, including all
prior tests (no regression in the existing ~40 tests).
*Fails if:* either command exits non-zero.
