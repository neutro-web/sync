# ns Phase 2 Gate — Concurrent Strategy + Conflict Resolution

> Written before code per AGENTS.md discipline.
> Design basis: `docs/design/conflict-resolution.md` (Model C + last-confirmed-winner).
> All items must be independently failable (a pass that cannot fail proves nothing).

## Gate items

**Q1 — Strategy produces `concurrent`.**
A unit test drives two causally-independent versions through `VectorClockStrategy.compare()`.
Expected: `"concurrent"` in both directions.
Failure: returns `"before"` or `"after"` for genuinely unrelated versions.

**Q2 — Conflict detected and held (Model C).**
Two replicas write the same unit concurrently with `VectorClockStrategy`. `apply()` records an
open conflict and fires `onConflict` with both sides. `apply()` must return synchronously
(assert via sync-flag check — no `await` in the call chain). Cursor must NOT advance on the
conflicting change; last-confirmed value must remain the confirmed state.
Failure: `apply()` hangs, conflict silently dropped, cursor advances on unresolved conflict.

**Q3 — Resolver wiring is live (closes Phase 1b Finding #3).**
A `ResolverPump` wired to an engine with a recording resolver IS invoked when a `concurrent`
conflict fires. Assert: resolver was called exactly once with the correct conflict payload.
Failure: resolver never called (the Phase 1b P5 trivial-pass condition — resolver was dead
under ALL paths, not just LWW).

**Q4 — Resolution converges (headline).**
Two replicas driven into a genuine `concurrent` conflict under the unreliable channel (fault
injection). A `ResolverPump` with a deterministic resolver (pick-by-change-id, approach (a))
fires on each replica independently. After resolution + drain, both replicas agree on the same
unit value.
Convergence mechanism: **approach (a) — deterministic pure function of the conflict.** The
resolver selects the change whose `id.value` is lexicographically larger; the same decision is
reached on every replica independently without propagating the resolution as a separate change.
Failure: replicas disagree post-resolution.

**Q5 — `defer` holds, never drops.**
A resolver returning `defer` leaves the open conflict entry intact. The unit keeps its
last-confirmed value. No cursor advance. The conflict remains resolvable (a subsequent
`resolveConflict` with a concrete decision lands correctly).
Failure: `defer` drops either side, advances state, or loses the conflict entry.

**Q6 — Last-confirmed-winner reads.**
During an open conflict, `snapshot()` returns the last resolved value; `changes()` does not
include the concurrent incoming change. Unresolved state must not leak into either read path.
Failure: concurrent/unresolved state appears in `snapshot()` or `changes()`.

**Q7 — No regression.**
All 24 existing tests green, harness files unmodified; `tsc --noEmit` clean.
Failure: any prior test broken, type error introduced.

## Conscious scope boundary

`_applyOp`'s `concurrent` arm is NOT activated in this phase. The op-with-version path stores
only the last accepted `Version` per unit (`opUnitVersions`), not the full `VersionedChange`
needed to populate `Conflict.local`. Routing it correctly requires storing the full change —
a scoped follow-up, not a Phase 2 blocker. The arm remains an honest deferred return.

**Multi-way conflicts (more than two concurrent writes to the same unit before the first is
resolved):** `openConflicts` holds only the LATEST conflict per unit — a second concurrent
write overwrites the first entry's `remote` side. The first `remote`'s id is not in `seenIds`
(per the F3 fix) so it can re-arrive via gossip, opening the conflict again. Phase 2 does not
test or guarantee correct handling of more than two simultaneous concurrent versions per unit.

**`merged` resolution:** the `merged` case in `resolveConflict` is NOT implemented in this
phase. With `VectorClockStrategy`, `this._clock.mint()` produces a version with no causal
history from either input (`{ engineNodeId: N }`), which is `concurrent` with both `local`
and `remote` — gossiping the merged change would open a recursive conflict. The correct fix
requires `ClockStrategy.mergeVersions(a, b)` (a seam-contract addition, out of scope). The
implementation throws to make this explicit; callers must use `take-local`, `take-remote`,
or `defer`.

## Summary table

| Item | Replicas | Driver | Assertion |
|---|---|---|---|
| Q1 | — | two independent `VectorClockStrategy` instances | `compare → "concurrent"` both ways |
| Q2 | 2 | concurrent write, `VectorClockStrategy` | conflict held; `apply` sync; cursor not advanced |
| Q3 | 1+ | conflict + `ResolverPump` + recording resolver | resolver invoked with correct payload |
| Q4 | 2 | concurrent write + faults + pump + deterministic resolver | both agree post-resolution |
| Q5 | 1 | conflict + `defer` | conflict entry intact; last-confirmed shown; subsequent resolution lands |
| Q6 | 1 | open conflict | `snapshot`/`changes` show last-confirmed only |
| Q7 | all | full suite | 24+ green, harness untouched, `tsc --noEmit` clean |
