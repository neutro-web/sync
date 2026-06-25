# ns Design Note — Framework Composition Model

> **Status:** Design doc (reusable analysis). Referenced by the decision-log entry of
> 2026-06-24 that locks the adapter packaging model. This note records *how `ns` composes onto
> vanilla TS and every frontend framework*, and the constraints that places on the open Public
> API gate (G2). It is not itself a frozen API — the write/emit ergonomics are explicitly left
> to design-and-implementation (see §4). A future API session re-reads this to inherit the
> constraints rather than re-deriving them.

---

## 1. The claim

`ns` composes on **(a) vanilla JS/TS as the primary surface** and **(b) every frontend
framework via thin adapters**. Both are *forced by already-locked decisions*, not aspirations:

- **Standalone** (locked) — `ns` has no neutro-sibling or framework dependency. The core is
  plain TS.
- **`value` is `unknown`** (T4) — the core marshals no value model, so adapters have nothing to
  translate; they forward opaque changes.
- **The seam is "a subscription that delivers changes"** — every framework has exactly one
  native primitive it wants changes delivered into. That single boundary is what keeps adapters
  thin.

---

## 2. The framework-binding seam: three primitives, identical for every framework

Every adapter binds the *same three* core operations onto a framework's native reactivity
primitive. An adapter that needs more than these — that must understand a `Change`, touch a
`Cursor`, or hold conflict/transport logic — is a signal the **core API is wrong**, not that the
adapter is legitimately thick.

| Core primitive | Shape | What the adapter does with it |
|---|---|---|
| `subscribe(scope, handlers)` | register `onBatch`/`onConflict`; returns unsubscribe | wires it to the framework's subscription mechanism |
| `snapshot(scope)` | current-state-on-subscribe (Seam Contract §4) | seeds the framework's initial value (memoryless frameworks need this) |
| `emit` / local-write | submit a local change (ergonomics TBD, §4) | exposes a setter/dispatch on the framework side |

### Per-framework mapping (each adapter is a few lines over these three)

- **React** → `useSyncExternalStore(subscribe, getSnapshot)`. Near-exact: `subscribe` *is*
  `ScopeRouter.subscribe`; `getSnapshot` *is* `Feed.snapshot`.
- **Svelte** → the store contract `{ subscribe(cb): () => unsubscribe }` — already `ns`'s
  subscription shape; the adapter is almost an identity function.
- **Vue** → `shallowRef` seeded from `snapshot`, written on `onBatch`.
- **Solid / signals libraries (incl. a reactive view engine consuming ns)** → the external-source
  / `{ subscribe }` seam. (Verified during the seam-contract design that a reactive view engine
  exposes exactly this `{ subscribe }`-shaped boundary; `ns`'s subscription fits it directly.)
- **Angular** → wrap the subscription as an RxJS `Observable` or a signal.

The pattern under all five is identical: **`subscribe` + `snapshot` + `emit` → the framework's
native primitive.** No sync logic crosses into the adapter.

> **Why thinner than a CRDT's framework binding:** a CRDT binding must marshal the CRDT's value
> model into framework state. `ns`'s adapter has nothing to marshal — `value` is `unknown`, so
> the adapter forwards opaque changes. `ns` adapters are strictly thinner than Yjs/Automerge
> framework bindings for this reason.

---

## 3. The constraint this places on the Public API gate (G2)

For both composition claims to hold, the public API must satisfy this property (a near-axiom;
pre-committed because the alternative contradicts the standalone axiom):

> **The core consumer-facing API is plain TS — callbacks and promises, no framework type and no
> reactivity primitive in any core signature.** Framework integration is *exclusively additive*,
> living in adapter modules that depend on `ns`, never the reverse. The vanilla API is the *real*
> API, not a stripped framework API; every adapter is additive over it.

Failure mode this rules out: a core that secretly assumes signals/observables, making vanilla
the adapter and a framework first-class. That inverts the dependency direction and breaks
standalone. Vanilla-callbacks-first is the base precisely because it makes every adapter additive.

---

## 4. Deliberately deferred to design-and-implementation (NOT decided here)

- **The `emit` / local-write ergonomics.** The read side (`subscribe`/`snapshot`) is clean and
  uniform. The write side — how an app submits a local change, optimistic-apply behavior, the
  batching API, how a framework setter maps onto it — has real design freedom and will be
  *discovered* in design and implementation, not pinned now. This is the substantive remaining
  half of G2.

---

## 5. Adapter packaging (DECIDED — see decision log)

Adapters are **subpath exports** of the single `@neutro/sync` package, not separate packages:
`@neutro/sync/adapters/react`, `@neutro/sync/adapters/svelte`, etc. One version, one release,
one install. Rationale and the tree-shaking/optional-peer requirements are in the decision-log
entry and AGENTS.md "Repo shape."
