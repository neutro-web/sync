# ns Design Note — Concurrent-Conflict Resolution Model (Phase 2)

> **Status:** Design doc (reusable analysis). Referenced by the decision-log entry that opens
> Phase 2. Records the chosen model for resolving `concurrent` outcomes — the T4 path Phase 1b
> correctly deferred. **No seam-contract change required**; this is engine internals plus one
> new engine method. A future session re-reads this to implement or extend conflict handling.
>
> **Working rule:** BCon.

---

## 1. The tension this resolves

`apply()` is synchronous (`return Promise.resolve()`), and both the implementation and the
convergence harness depend on synchronous subscription dispatch for drain-round determinism. But
`Resolver.resolve()` returns `Resolution | Promise<Resolution>`, and the async case is
non-negotiable (manual resolution, async CRDT merge, and `defer` held across time). Therefore a
`concurrent` outcome **cannot in general be resolved inside the synchronous `apply` call.**

The real question is not "how do we call the resolver" but **"what is the engine's state while a
conflict is open?"** — which the seam contract anticipated (`defer` = open conflict held across
time) but the engine has no representation for yet.

---

## 2. Models considered

**Model A — `apply` becomes async, awaits the resolver inline.** REJECTED. A `defer` resolution
never settles → `apply` hangs forever on a manual conflict; serializes the batch behind one slow
conflict; **violates the mandate** ("local progress never blocks on the channel" becomes "blocks
on a human"); breaks every existing synchronous-drain test.

**Model B — fire-and-forget: route to resolver async, don't await, apply the resolution when it
lands.** Viable. Keeps `apply` synchronous. But forces an explicit open-conflict state anyway
(what the unit shows between detection and resolution), and entangles the engine with the
resolution lifecycle (racing resolutions, promise bookkeeping inside core).

**Model C — detect-and-hold (CHOSEN).** `apply` detects `concurrent`, records both versions as
**open-conflict state** for the unit, fires `onConflict` as a *notification*, returns
synchronously. The engine does **not** own the resolution lifecycle. Resolution is a separate,
explicit engine transition driven from outside core. A `Resolver` that wants automatic resolution
is an **optional pump** layered on top (subscribe to `onConflict` → call `resolve` → feed the
answer back). Manual / `defer` is then not a special case — it is simply "no pump, or pump
returned `defer`": the conflict stays open until someone resolves it.

---

## 3. Why Model C

It is the literal implementation of the contract's T4 sentence: *"`ns` builds the `Conflict`
payload and hands it to a pluggable `Resolver`; it never inspects `value`,"* and *"`defer` =
open conflict held across time."* The engine's job ends at **detect + hold + notify**; resolution
is a separate transition. Consequences:

- `apply` stays **synchronous** → mandate preserved, drain determinism preserved, all 24 existing
  tests stay green unchanged.
- `defer` gets a **real representation** (the open-conflict state is the default; held until
  resolved). It is no longer a code path that drops the change.
- **Detect-not-decide** is respected more precisely than await-routing could — the engine never
  holds a resolver promise in its critical path.
- The optional resolver-pump keeps automatic strategies (LWW-by-policy, CRDT-merge) ergonomic
  without putting the resolution lifecycle inside core.

---

## 4. Open-conflict read semantics — last-confirmed-winner (CHOSEN)

While a unit has an open conflict, `snapshot` and `changes` must return something deterministic.
**Decision: last-confirmed-winner.** The unit holds its last *resolved* state until the conflict
resolves; the open conflict is tracked separately; `snapshot`/`changes` never expose unresolved
state.

Rejected alternatives: *both-marked* (leaks a conflict representation into the read path —
`value` is opaque to ns, so the engine cannot construct a meaningful marker); *tentatively-newer*
(shows the incoming side optimistically → risks divergence if resolution goes the other way).

Last-confirmed-winner preserves the **confirmed-only guarantee** already in the contract (§4: the
feed carries facts, not optimism). A reader during an open conflict sees the last fact, never an
unresolved guess.

> **Convergence note (to verify in implementation, not assert):** two replicas that both detect
> the same `concurrent` conflict must, after both apply the *same* resolution, reach the same
> state. The resolution must therefore be a pure function of the conflict (deterministic given
> `local`/`remote`/`base`), or be propagated as its own change so all replicas converge on the
> resolver's decision rather than each resolving independently. **This is the load-bearing
> convergence question of Phase 2** and must be proven on ≥2 replicas, not argued.

---

## 5. Engine shape (internals — not the consumer-facing API, G2 stays closed)

- **`ScopeState.openConflicts: Map<unitKey, OpenConflict>`** — both competing `VersionedChange`s
  held per unit. The unit's confirmed winner is unchanged while this is populated.
- **`apply`'s `concurrent` arm** (currently `return false`, the F3-fixed honest deferral) →
  record the open conflict, fire `onConflict` notification, return. Still does not advance the
  cursor or mark resolved.
- **New engine method `resolveConflict(scope, unit, resolution)`** (internal, not the G2 client
  API) — applies a `Resolution`: `take-local`/`take-remote` selects a side; `merged` writes the
  merged value as a new confirmed change; `defer` leaves the conflict open. Resolution that lands
  a new confirmed state advances the cursor / durable log like any accepted change.
- **Optional `ResolverPump`** — subscribes to `onConflict`, calls `resolver.resolve`, calls
  `resolveConflict` with the answer. Lives outside `apply`. Absent ⇒ conflicts stay open (manual).

This adds **one internal method + one state map**. No seam-contract type changes — `Conflict`,
`Resolution`, `Resolver`, `onConflict` are all already frozen and sufficient.

---

## 6. What this unblocks / leaves open

- **Unblocks** Phase 2's first gate: a `concurrent`-producing strategy can now be routed,
  resolved, and tested end-to-end.
- **Leaves open (correctly):** the G2 consumer-facing API (how an app drives resolution
  ergonomically) — `resolveConflict` is an internal seam, not the public client. The pump is the
  bridge; its public ergonomics are a G2 concern.
