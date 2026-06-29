# Design — `merged` Resolution & `mergeVersions` (Phase 3 architect sub-gate)

> **Status:** Draft for decision. Stream: Architect (design only). **Outcome: a contract change
> is proposed** — `ClockStrategy.mergeVersions`, seam v1.0 → v1.1.
> **Crux (Q-C) grounded by throwaway spike** against `src/strategies/vector-clock.ts` (6/6, since
> discarded). Convergence *proof* on ≥2 replicas is routed to the implementation brief, not asserted here.

---

## 0. Problem

`Resolution` includes `{ decision: "merged"; value: V }`. A resolver returning `merged` produces a
**third value** — neither `local` nor `remote`. The engine currently **throws** on it
(`resolveConflict`, verified in source; tested in `phase2-conflict.test.ts`).

Landing a merged value needs two things to converge across replicas:

1. **Same value everywhere** — covered by the §5 resolver-determinism expectation *if* each replica
   runs the same pure merge on the same `(local, remote, base?)`.
2. **A `Version` for the merged value that dominates BOTH inputs** — the gap. `take-remote` reuses
   the remote's existing version (verified: no new version is minted). `merged` has no version to
   reuse. If the merged version does not causally dominate both inputs, the next `compare` against
   either input on gossip redelivery returns `concurrent` again → **the merge re-conflicts forever.**

`mergeVersions` is the proposed `ClockStrategy` method that mints the dominating version.

---

## 1. Verified source facts (GitHub authoritative, HEAD `1652b40`)

- `ClockStrategy` = `{ mint(prev?): Version; compare(a,b): "before"|"after"|"concurrent" }`. No
  `mergeVersions`. (`src/core/types.ts`.)
- `resolveConflict` `merged` arm throws *before* any state mutation. `take-local`/`take-remote`/
  `defer` are live. `take-remote` lands `open.remote` as-is — **reuses its version, mints nothing**.
  (`src/core/engine.ts`.)
- Winner stored as the full `StateChange` (carries `version`); `_applyState` reads
  `change.version` in `compare`. A merged result must land as a `StateChange` carrying the new value
  **and** the new version. (`src/core/engine.ts`.)
- `VectorClockStrategy.mint(prev?)` = merge prev's vector, then `+1` on the local node's slot.
  `compare` = element-wise dominance; `concurrent` iff neither dominates. (`src/strategies/vector-clock.ts`.)
- `LWWClockStrategy.compare` never returns `concurrent` (orders by `_ts`, ties by `_node`). So under
  LWW, `merged` is **unreachable**. (`src/strategies/lww.ts`.)

> The handoff referenced `docs/design/conflict-resolution.md`; that file does not exist in source
> (only `framework-composition.md`). Design proceeded from code + seam contract directly.

---

## 2. Q-C first — the crux (resolved: local merge converges)

**Claim under test:** can a locally-computed merged version be made **identical across replicas**?
If yes → local merge converges, no propagation needed. If no → `merged` must be propagated (§4).

Concurrent inputs `A = {A:1}`, `B = {B:1}` (`compare → concurrent`). Two candidate merge rules:

**Rule 1 — max-then-local-increment** (reuse `mint`-style increment):
replica A computes `{A:2, B:1}`; replica B computes `{A:1, B:2}`. `compare` → **concurrent**.
The two merged versions re-conflict with *each other*. **Broken.**

**Rule 2 — max-only (causal join, no increment):**
both replicas compute `{A:1, B:1}`. Properties (spike-verified, 6/6):
- **Identical across replicas** — element-wise max is commutative; order of `(a,b)` is irrelevant.
  (Caveat: structurally the record key-order may differ — `{A,B}` vs `{B,A}` — so equality must be
  tested via `compare`, never `JSON.stringify`. This is a real constraint, see §3 Q-A.)
- **Dominates both inputs** — `compare(merge, A) → after`, `compare(merge, B) → after`.
- **No re-conflict on redelivery** — `compare(A, merge) → before` → input is skipped, not re-held.
- **Subsequent local write dominates** — `mint(merge) → {A:2,B:1}`, `compare → after`.
- **Composes N-way** — `maxMerge(maxMerge(A,B), C) = {A:1,B:1,C:1}` dominates all three.

**Does max-only break the VC invariant?** No. A node's slot counts *that node's authored writes*.
A max-only join authors no new write — it records "this replica has now seen both causal histories,"
which is exactly a vector-clock join. The next authored write increments correctly off the joined
clock. The merge is a **causal join, not an event**; nothing in the strategy's invariant requires a
join to bump a slot.

**Q-C verdict:** Rule 2 (max-only) makes the merged version identical on every replica. Combined with
the already-required deterministic value-merge (§5), **local independent merge converges.**
Propagation is **not forced** for vector clock.

---

## 3. Q-A — the signature

```ts
mergeVersions(a: Version, b: Version): Version   // returns a version dominating both
```

- **Versions only, not values.** Versioning is value-opaque to ns (T2). The *value* merge is the
  Resolver's job (`Resolution.value`); the *version* merge is the strategy's. Passing values into
  `mergeVersions` would leak domain data into the version slot — a T2 violation.
  *Steelman of "pass values":* a strategy might want to derive a version from value content (e.g.
  content-hash clock). *Leak:* that strategy can hash inside its own `Resolver`/value pipeline and
  feed the result through `mint`; it does not need ns to hand it the value. T2 holds. **Versions only.**
- **No `base`.** `base` is for three-way *value* merge (the Resolver). The dominating *version* is a
  function of the two competing versions alone.
- **Binary, not variadic.** Phase 2 holds exactly one open conflict per unit (`{local, remote}`,
  last-in-wins on overwrite — verified in source). The payload is binary, so the method is binary.
  N-way composes by association (`merge(merge(a,b), c)`) — proven in the spike. If multi-way open
  conflicts land later, that is a *separate* gate; do not pre-build variadic.
- **Output must be canonical.** Because two replicas may build the record with different key
  insertion order, the contract states: **the engine compares versions only via `compare`, never
  structurally.** `mergeVersions` need not canonicalize its output bytes; it must only guarantee
  `compare`-equality across replicas. (Strategies that *do* expose structure elsewhere should
  canonicalize defensively — noted, not mandated.)

---

## 4. Q-B — dominance per strategy, and optional vs mandatory

| Strategy | `mergeVersions` | Notes |
| --- | --- | --- |
| **Vector clock** | element-wise max, **no increment** | Dominates both; identical across replicas. Verified. |
| **LWW** | **not applicable** | `compare` never returns `concurrent` → `merged` unreachable → method never called. |
| **HLC (Phase 3+)** | max of (physical, logical) components | Dominance holds (HLC is a bounded Lamport clock); identical across replicas because max is deterministic. To verify when built. |
| **CRDT position (Phase 3+)** | strategy-internal join | A position CRDT's merge is its native operation; "merged" is the *common* case, not the exception. Dominance is the CRDT's own guarantee. To verify when built. |

**Optional vs mandatory — DECISION: optional.**

`mergeVersions` is **optional** on `ClockStrategy`. Rationale:
- A strategy whose `compare` never returns `concurrent` (LWW) can never reach a `merged` resolution
  for a conflict it produced — the method would be dead. Forcing it to implement a throwing stub is
  noise.
- The type cost of optionality is one `?`:
  ```ts
  interface ClockStrategy {
    mint(prev?: Version): Version;
    compare(a: Version, b: Version): "before" | "after" | "concurrent";
    mergeVersions?(a: Version, b: Version): Version;   // optional
  }
  ```
- **Engine guard:** in the `merged` arm, if `this._clock.mergeVersions` is `undefined`, **throw a
  precise error** ("strategy X does not support merged resolution") rather than silently dropping.
  This converts "merged under a non-merge strategy" from a silent divergence into a loud,
  contract-accurate failure.

*Steelman of "mandatory":* mandatory removes the `undefined` check and the throw-path. *Leak:* it
forces every strategy — including ones for which merge is meaningless — to ship a stub, and the stub
*still* has to throw, so the failure mode is identical. Optional is strictly cleaner. **Optional.**

**Strategy where dominance is ill-defined (a real finding):** any strategy whose version space is
**not a join-semilattice** — e.g. a pure wall-clock with no node component, where two distinct
writes can carry the identical timestamp and there is no deterministic "combine" that dominates
both without inventing a tiebreak. Such a strategy cannot support `merged`; it must omit
`mergeVersions`, and the engine's guard will (correctly) refuse a `merged` resolution under it. This
is the contract working as intended: **`merged` is available only where the version space admits a
dominating join.**

---

## 5. Q-D — the engine landing path (`merged` arm of `resolveConflict`)

Replace the throw with (pseudocode against verified source structure):

```
merged:
  if (!this._clock.mergeVersions) throw Error("strategy lacks mergeVersions; merged unsupported")
  mergedVersion = this._clock.mergeVersions(open.local.version, open.remote.version)
  mergedChange: StateChange = {
    id:       makeChangeId(fresh),          // new id — see note
    kind:     "state",
    scope, unit,
    value:    resolution.value,             // from the Resolver
    version:  mergedVersion,
    lifetime: open.local.lifetime,          // see lifetime note
  }
  openConflicts.delete(unit.key)
  seenIds.add(open.local.id.value); seenIds.add(open.remote.id.value)   // inputs won't re-open
  if durable:
    durableStateUnits.set(unit.key, { change: mergedChange })
    cursorSeq++; durableLog.push({ change: mergedChange, seq: cursorSeq })
  else:
    ephemeralStateUnits.set(unit.key, { change: mergedChange })
  onBatch({ scope, changes: [mergedChange], cursor? })   // fire to subs (gossip propagates value)
```

**Why redelivery of an original input no longer conflicts:** the input's version is now `before`
the landed `mergedVersion` (dominance), so `_applyState` takes the `before` arm → `seenIds.add` +
skip. Belt-and-suspenders: the inputs' ids are also in `seenIds`, so dedup catches them first.

**New id, not a reused one.** The merged change is a distinct fact; it must carry its own
`ChangeId`. Convergence does **not** depend on the id being identical across replicas (dedup is per
replica; the *version* carries cross-replica identity via `compare`). The id must only be locally
unique. *(If a later phase propagates the merged change as an outbound gossip — see §6 — id
stability across replicas becomes a question; for local-merge it does not.)*

**Lifetime.** Use `open.local.lifetime`. A conflict only arises when both sides touch the same unit
with the same lifetime class (a durable and an ephemeral write to one unit is itself a separable
concern — out of scope here; flag if the impl finds the maps can hold a cross-lifetime pair).

---

## 6. The propagation question (§4 of handoff) — DECISION: local merge, no propagation

Because Q-C resolved to a **deterministic dominating version (max-only)**, the merged value +
version are computed identically on every replica that runs the same pure resolver. **No outbound
propagation hook is required for `merged` under vector clock.** This is the simpler mechanism and it
is the one the analysis supports.

This holds **conditionally** on the resolver being a deterministic pure function — already the §5
v1.0 requirement. The convergence chain:
1. Every replica detects the same `concurrent` pair (vector clock is deterministic).
2. Every replica's resolver returns the same `merged` value (§5 determinism).
3. Every replica's `mergeVersions(a,b)` returns a `compare`-equal dominating version (Q-C, max-only).
4. ⇒ every replica lands the same `(value, version)` for the unit; redelivery dominates and is skipped.

**When propagation WOULD be needed (documented, not built):** if a future strategy's merge cannot
produce a cross-replica-identical dominating version by local computation (Q-B "ill-defined" case),
OR if the resolver cannot be made deterministic (e.g. merges depend on local-only data), then
`merged` for *that strategy/resolver* must propagate the resolved change as a normal durable gossip,
applied via the existing `apply` path. That is a larger engine surface (an outbound "resolution →
change" hook) and is **explicitly deferred** to a separate gate. The §5 note already frames
propagated resolution as a Phase 3 concern; this design does not consume that budget.

---

## 7. Convergence argument vs. proof

The argument in §6 is **reasoned, with the load-bearing step (Q-C) spike-grounded** against the real
vector-clock strategy. Per AGENTS.md, a convergence claim is **not verified** until it runs on ≥2
replicas driven apart over a simulated unreliable channel. The spike tested *version algebra in
isolation*, not the full engine `apply`/`resolveConflict`/gossip loop. **The ≥2-replica convergence
test is the implementation brief's load-bearing gate item** (it is the test that catches the Q-C
crux at the engine level, and would go RED under Rule 1).

---

## 8. Open sub-questions routed forward (not blocking the decision)

- **Cross-lifetime conflict on one unit** — can `openConflicts` ever hold a durable+ephemeral pair?
  If so, which lifetime does the merge take? Flag for impl; likely cannot arise given current
  routing, but assert it.
- **HLC / CRDT-position `mergeVersions`** — dominance claimed, to verify when those strategies land.
- **`_applyOp` concurrent path** — independent Phase 3 runtime sub-gate (op must carry
  `VersionedChange`). `merged` for ops inherits this design once that path exists. Do not couple.
