# @neutro/sync (ns) — Seam Contract

> The contract surface of **`@neutro/sync` (`ns`)**, a universal sync layer: the minimal set of types a consumer (a reactive database, a shared-state library, a reactive view engine, a reactive form library, queues, rich-text, presence, …) configures against. Derived from the T1–T5 decisions of the design session. Nothing here is domain-specific. CRDT internals, concrete transports, peer/mesh logic, and persistence engines are **out of scope** and deferred to the dedicated `ns` implementation session.
>
> Throughout, **"`ns`"** names the engine this spec defines; **"a consumer"** names any library that configures against it. Consumers are referred to by role (a reactive database, a reactive view engine, …), never by product name, so the contract stays implementation-neutral.

---

## Decision Recap (the load-bearing rulings this surface encodes)

| Tension | Ruling |
| --- | --- |
| **T1** State vs. op through one Feed | One discriminated `Change` type. The discriminator encodes three coupled properties — `idempotent`, `replay`, `ordering` — not just payload shape. `state` and `op` are the two coherent presets. A single batch is heterogeneous. Op-changes dedup by `id`; they **may optionally carry a `version`** for *op-transport-with-local-fold* consumers (a reactive database, a reactive view engine) that own their own reconciliation and need version-based collision detection on top of op delivery. |
| **T2** Versioning generality | Split: **`Cursor`** (feed position, `ns`-owned, concrete) vs. **`Version`** (per-unit comparison token, strategy-owned, opaque to `ns`). `ns`'s entire versioning involvement is `strategy.compare() → before \| after \| concurrent`. State-changes always carry a version; op-changes carry one only when the consumer folds with collision detection (e.g. a per-unit revision token). |
| **T3** Ephemeral/durable in one pipe | Lifetime is a per-change property gating two independent subsystems (persistence sink, replay source). **Ephemeral changes never advance the cursor**, are never persisted, are never replayed. Reconnect forks: durable = replay-from-cursor; ephemeral = snapshot-of-current. Snapshot also serves a *durable* consumer behind a memoryless transport (an event-only carrier that never replays last-value). |
| **T4** Conflict payload | Payload = `{ unit, local, remote, base?, scope }`, all domain-opaque. Resolver returns a four-valued `Resolution` (`take-local \| take-remote \| merged \| defer`), never mutates. `defer` is the detect-not-decide escape hatch and the universal form of an open/pending conflict. |
| **T5** Ordering | `ns` promises **per-scope causal order** and nothing stronger. Total order per scope falls out of feed sequence for op-changes; cross-scope total order is an explicit **anti-promise** (would require a coordinator, violating the mandate). |

**Mandate:** *Sync is the reconciliation of two or more diverging replicas of some state over an unreliable channel, where local progress must never block on the channel.*

---

## 1. `Change` — the atom that flows

The discriminator is `kind`. It selects a **preset over three properties** the engine reads. Consumers should think in `kind`; the engine thinks in the properties.

```ts
/** The three properties the discriminator actually governs (T1). */
interface ChangeSemantics {
  /** Re-applying the same change is a no-op (state) vs. must-not-double-apply (op). */
  readonly idempotent: boolean;
  /** Replay policy from a cursor. */
  readonly replay: "latest-only" | "all";
  /** Ordering requirement within a scope. */
  readonly ordering: "per-key" | "total";
}

/** Fields common to both flavors. */
interface ChangeBase {
  /** Globally unique change id. Required for op dedup; useful for tracing state. */
  readonly id: ChangeId;
  /** The scope/topic this change belongs to (partition key). */
  readonly scope: Scope;
  /** The conflict-unit this change touches. Opaque comparable token to `ns`. */
  readonly unit: ConflictUnit;
  /** Durable vs ephemeral(ttl) — gates the T3 fork. */
  readonly lifetime: Lifetime;
  /** The payload. `unknown` to `ns`; the consumer/resolver casts it. */
  readonly value: unknown;
}

/**
 * "field X is now Y". Idempotent, latest-wins-able.
 * Preset: { idempotent: true, replay: "latest-only", ordering: "per-key" }
 */
interface StateChange extends ChangeBase {
  readonly kind: "state";
  /** Strategy-owned comparison token. Opaque to `ns`. Drives conflict detection. */
  readonly version: Version;
}

/**
 * "do X". Intent; must apply exactly once; order-sensitive.
 * Preset: { idempotent: false, replay: "all", ordering: "total" }
 * Deduped by `id` and ordered by feed position.
 *
 * `version` is OPTIONAL and present only for op-transport-with-local-fold
 * consumers — those that own their own reconciliation (an optimistic
 * base-plus-pending model, or a reactive signal graph) and transport ops while
 * still needing version-based collision detection on the conflict-unit (e.g. a
 * per-unit revision token). Pure-intent op consumers (queues, telemetry) omit
 * it; they need only id-dedup.
 */
interface OpChange extends ChangeBase {
  readonly kind: "op";
  readonly version?: Version;
}

type Change = StateChange | OpChange;

/**
 * A change that carries a version, hence can participate in conflict detection:
 * every StateChange, plus the OpChanges that opted into a version (the local-fold
 * consumers). Pure-intent OpChanges (no version) are excluded — they never conflict.
 */
type VersionedChange = StateChange | (OpChange & { readonly version: Version });

/** The semantics each kind resolves to. The engine reads this, not the label. */
declare const PRESETS: {
  readonly state: { idempotent: true; replay: "latest-only"; ordering: "per-key" };
  readonly op:    { idempotent: false; replay: "all"; ordering: "total" };
};
```

> **Why one type:** a transport batch may carry a presence update (state/ephemeral) and a queued command (op/durable) together — "one pipe". Parametric separation (`Feed<StateChange>` / `Feed<OpChange>`) cannot express a heterogeneous batch; two feeds reintroduce domain branching above the engine. The `apply`-time branch on `kind` is the irreducible domain distinction, not domain-specific code.

> **Why a mixed consumer doesn't "pick":** a consumer like a reactive form library carries individual changes each independently `state` or `op`. The submit is one op-change in a stream of state-changes. No consumer chooses a feed flavor.

---

## 2. `Cursor` & `Version` — the T2 split

Two concepts the brief conflated. They answer different questions and have different owners.

```ts
/**
 * "Where am I in this feed?" — answers replay.
 * `ns`-OWNED and concrete. Opaque to *consumers* (never constructed by
 * them), structured for the engine. Monotonic per scope. Only DURABLE changes
 * advance it (T3).
 */
declare const CursorBrand: unique symbol;
interface Cursor {
  readonly [CursorBrand]: true;
  readonly scope: Scope;
}

/**
 * "Is my copy of unit X newer than yours?" — answers conflict detection.
 * STRATEGY-OWNED and OPAQUE to `ns`. Carried as a black box on a
 * change. The engine never reads inside it; it only calls strategy.compare().
 */
declare const VersionBrand: unique symbol;
interface Version {
  readonly [VersionBrand]: true;
}

/** The pluggability slot for versioning. The whole generality lives in `compare`. */
interface ClockStrategy {
  /** Mint a version for a new local state-change. */
  mint(prev?: Version): Version;
  /**
   * Three-valued comparison — the entirety of `ns`'s versioning involvement.
   *  - LWW:    version = timestamp; never returns "concurrent".
   *  - merge:  version = logical/hybrid clock; "concurrent" → merge-fn.
   *  - CRDT:   version = vector/position; "concurrent" is the common case.
   */
  compare(a: Version, b: Version): "before" | "after" | "concurrent";
}
```

> Implementations of `ClockStrategy` (HLC, vector clock, wall-clock LWW, CRDT position) are deferred to the `ns` implementation session. This spec freezes only the **boundary**.

---

## 3. `Lifetime` — the T3 fork selector

```ts
type Lifetime =
  | { readonly class: "durable" }
  | { readonly class: "ephemeral"; readonly ttlMs: number };
```

Behavior gated by `class` (frozen guarantees, not implementation):

| | `durable` | `ephemeral` |
| --- | --- | --- |
| Written to local change log | yes | **no** |
| Included in `changes(since)` replay | yes | **never** |
| Advances the `Cursor` | yes | **no** |
| Expiry | never | `ttlMs` countdown, then dropped (optional tombstone) |
| On reconnect | replay-from-cursor | snapshot-of-current (not history) |

> **The guarantee that makes "no shared cost" real:** ephemeral changes never advance the cursor. Replay is `O(durable changes since checkpoint)`, independent of ephemeral volume. Symmetrically, ephemeral changes never touch the persistence sink, so a disk fsync never sits in the path of a presence broadcast.

> **TTL is local-only.** Each replica runs its own TTL clock; expiry needs no network message — absence *is* the signal.

---

## 4. `Feed` — the symmetric seam

Carries the T3 reconnect duality: durable replay vs. ephemeral snapshot are **named separately**.

```ts
interface ChangeBatch {
  readonly scope: Scope;
  readonly changes: readonly Change[];
  /**
   * Cursor AFTER applying this batch. Reflects only durable changes (T3).
   * Absent for snapshot-only (purely ephemeral) batches.
   */
  readonly cursor?: Cursor;
  /**
   * Atomicity flag (return-path item E). When true, `ns` guarantees
   * the batch is all-or-nothing: `changes()` never emits a partial/aborted
   * transaction. Permitted by the contract; not all consumers require it.
   */
  readonly atomic?: boolean;
}

/**
 * Current-state snapshot — what is live NOW for a scope, with no history.
 * Two consumers need this:
 *  1. Ephemeral reconnect (presence/awareness) — there is no replay by design.
 *  2. A DURABLE consumer behind a memoryless transport (an event-only carrier
 *     that delivers no last-value to a late subscriber). It needs current state
 *     on subscribe because the transport will not replay it.
 * Carries no cursor: a snapshot is a starting point, not a replay position.
 * A durable consumer pairs snapshot() (initial state) with changes() (ongoing
 * replay from the cursor it begins tracking after the snapshot).
 */
interface Snapshot {
  readonly scope: Scope;
  /** Current-state changes only; no history. */
  readonly changes: readonly Change[];
}

interface Feed {
  /**
   * OUT — durable replay. Emits durable changes since `cursor` in causal order
   * per scope (T5). Never emits ephemeral changes. Never emits a partial
   * transaction when atomicity is requested.
   *
   * CONFIRMED-ONLY: the feed emits only changes the consumer has committed as
   * facts — never optimistic/pending state still subject to local rollback.
   * (A reactive database: only committed/base-folded changes, never optimistic
   * pending ones. A reactive form library: only committed field values, never a
   * field mid-edit.) The feed carries facts, not optimism.
   */
  changes(scope: Scope, since: Cursor | null): AsyncIterable<ChangeBatch>;

  /**
   * OUT — current-state-on-subscribe. Used for ephemeral reconnect (no replay
   * exists) AND by durable consumers behind a memoryless transport that will
   * not replay last-value (an event-only carrier). Distinct from `changes()`: a
   * snapshot is a starting point, not a replay position.
   */
  snapshot(scope: Scope): Promise<Snapshot>;

  /**
   * IN — apply a batch from a peer/transport. Branches on each change's `kind`
   * (idempotent state; dedup-by-id op; op-with-version folds and may conflict).
   * Detects conflicts and surfaces them via the Resolver; never silently decides.
   */
  apply(batch: ChangeBatch): Promise<void>;
}
```

---

## 5. `Conflict` & `Resolver` — the T4 payload + its inverse

```ts
/**
 * The universal conflict-surface payload. Built by `ns`, handed to a
 * Resolver. Every field is domain-opaque. A consumer that holds open conflicts
 * (e.g. a reactive database's pending-conflict object) is a specialization of this.
 */
interface Conflict<V = unknown> {
  /** What collided. Opaque comparable token; also `ns`'s dedup key for
   *  simultaneous conflicts on the same unit. */
  readonly unit: ConflictUnit;
  /**
   * The two competing changes, including their versions. Both, always.
   * Typed as `VersionedChange` — a StateChange, or an OpChange that carries a
   * version (the op-transport-with-local-fold case). A conflict can only arise
   * on a change that carries a version to compare; pure-intent ops (no version)
   * never produce a conflict — they dedup by id and apply.
   */
  readonly local: VersionedChange;
  readonly remote: VersionedChange;
  /**
   * Last common-ancestor value, IF the consumer's storage can supply it.
   * Optional by decision: three-way merge needs it; LWW/CRDT don't, and
   * forcing ancestry retention would tax LWW consumers. `ns` does not
   * compute it.
   */
  readonly base?: V;
  /** Which topic/partition — resolvers are often scope-configured. */
  readonly scope: Scope;
}

/** The resolver's answer. A question's reply, never a mutation the engine didn't sanction. */
type Resolution<V = unknown> =
  | { readonly decision: "take-local" }
  | { readonly decision: "take-remote" }
  | { readonly decision: "merged"; readonly value: V }
  | { readonly decision: "defer" }; // surface to human; hold both, open conflict

/** The pluggability boundary for conflict policy. Chosen by scope/consumer config. */
interface Resolver<V = unknown> {
  resolve(conflict: Conflict<V>): Resolution<V> | Promise<Resolution<V>>;
}
```

> **`Promise` is non-negotiable.** Manual resolution and async CRDT merges both need it, which means `ns` must tolerate an **open conflict** (unresolved, both versions held) across time. That open state is what a consumer's pending-conflict object represents. `defer` is the detect-not-decide escape hatch; everything else is the engine earning permission to converge.

> **Anti-leak boundary:** `local.value` is `unknown` to `ns`. The payload is the question, never a hint at the answer — the engine does not tag a conflict with a suspected policy.

---

## 6. `Scope` — partition key for subscription

```ts
/** Opaque partition key: document id, room, collection, key-prefix, etc. */
declare const ScopeBrand: unique symbol;
interface Scope {
  readonly [ScopeBrand]: true;
  readonly key: string;
}

interface Subscription {
  /** Stop receiving changes for this scope. Idempotent. */
  unsubscribe(): void;
}

interface ScopeRouter {
  /**
   * Subscribe to a scope. Guaranteed granularity: per-scope causal order (T5).
   * `onBatch` receives durable replay + live changes; `onConflict` surfaces
   * detected collisions for the resolver bound to this scope.
   */
  subscribe(
    scope: Scope,
    handlers: {
      onBatch(batch: ChangeBatch): void;
      onConflict(conflict: Conflict): Resolution | Promise<Resolution>;
    }
  ): Subscription;
}
```

> **Guaranteed granularity:** per-scope causal order. **Anti-promise:** no cross-scope total order (T5) — that requires a coordinator and violates "local progress never blocks on the channel". A consumer needing cross-scope total order must collapse those scopes into one.

---

## 7. `Transport` — the minimal carrier contract

Fully abstract. Same engine cross-tab and cross-device with only the transport swapped (ws, http-poll, webrtc, BroadcastChannel, in-process).

```ts
interface Transport {
  /** Send a batch to peer(s). Resolves when handed to the carrier, NOT when
   *  acknowledged — local progress must never block on the channel (mandate). */
  send(batch: ChangeBatch): Promise<void>;

  /** Receive batches from peer(s). The engine wires this to `Feed.apply`. */
  receive(onBatch: (batch: ChangeBatch) => void): void;

  /** Connection lifecycle — drives the reconnect fork (replay vs. snapshot, T3). */
  onConnect(handler: () => void): void;
  onDisconnect(handler: () => void): void;

  close(): void;
}
```

> Concrete transports are deferred. This freezes only what a transport must satisfy.

> **Flag for the `ns` implementation session — delivery guarantees live ABOVE the transport.** `send` resolving on hand-off (not ack) means at-least-once/exactly-once delivery, retry, and backpressure are **not** the transport's job — they live in the durable change log + cursor replay (a peer that missed a batch re-requests via `changes(since)`). This is deliberate and keeps "local progress never blocks on the channel" literal. **Retry policy, backpressure, and ack/redelivery semantics must be designed in the `ns` implementation session, not here** — this contract only guarantees they *can* be built atop the cursor/replay seam.

---

## 8. Shared opaque tokens

```ts
declare const ChangeIdBrand: unique symbol;
interface ChangeId { readonly [ChangeIdBrand]: true; readonly value: string; }

declare const ConflictUnitBrand: unique symbol;
interface ConflictUnit {
  readonly [ConflictUnitBrand]: true;
  /** `ns` compares units for equality/dedup only; never interprets structure. */
  readonly key: string;
}
```

---

## 9. The consumer map, re-expressed as knob settings

Proof the core generalizes — every consumer is pure configuration, zero engine code. Consumers are listed by role.

> Two patterns recur. **State-sync** consumers hand `ns` authoritative values and let it overwrite (LWW/merge). **Op-transport-with-local-fold** consumers (a reactive database, a reactive view engine) own their own reconciliation (an optimistic base-plus-pending model; a reactive signal graph), transport *ops*, fold them locally, and carry a `version` for collision detection — the engine never overwrites their authoritative state. Consumers with no prior state model (a reactive form's field state) want pure state-sync; consumers that already own one tend to want op-fold.

| Consumer (by role) | `lifetime` | `kind` | `unit` | version? | `ClockStrategy` | `Resolver` |
| --- | --- | --- | --- | --- | --- | --- |
| reactive database | durable | **op** (row ops) | field/row | **yes** (revision token) | hybrid (per T2) | surface → policy |
| shared client state | durable | state | key | yes | LWW | take-by-version |
| collaborative app state | durable | state | field | yes | logical clock | merge-fn |
| derived/transient shared state | ephemeral | state | value | yes | LWW | take-remote |
| reactive view engine (overwrite model) | ephemeral | state | value | yes | LWW | take-remote |
| reactive view engine (fold model) | ephemeral | **op** | value | optional | logical / — | reduce-style fold |
| reactive form — field state | durable | state | field (typed path) | yes | logical clock | merge-fn + warning |
| reactive form — typing indicator | ephemeral(ttl) | state | field | yes | LWW | take-remote |
| reactive form — submit | durable | **op** | command | no | — | dedup-by-id |
| queue / outbox | durable | op | command | no | — | dedup-by-id |
| rich text / canvas | durable | op | seq position | optional | CRDT position | merged (CRDT) |
| presence / awareness | ephemeral(ttl) | state | value | yes | LWW | take-remote |
| settings / prefs | durable | state | key | yes | LWW / logical | take-by-version / structural |
| telemetry / events | durable | op (append) | none | no | — | union (no conflict) |

**Notes on the load-bearing rows:**

- **A reactive database is op, not state.** Its `changes()` seam emits per-transaction batches of row ops (`insert`/`update`/`delete`), and remote application commits to a confirmed base then rebases optimistic pending changes, using a monotonic revision token for collision detection. That is op-transport carrying a version — the `OpChange.version` case. Modeling it as state-sync (overwrite) would contradict its own committed-base seam.
- **A reactive form is three rows, not one.** Field edits (durable state), a typing indicator (ephemeral state), and the submit (durable op) are independent per-change classifications *in the same form scope* — the proof that lifetime/kind live on the change, not the scope (T1/T3).
- **A reactive view engine admits two models.** Either `ns` holds the authoritative value and a signal mirrors it via a map-style write (overwrite), or the signals are authoritative and `ns` transports change events folded via a **reduce-style** primitive `(incoming, current) => next` — which is purpose-built for exactly this and cannot form a cycle (the `current` is delivered as data, not as a tracked read). The fold model is the more natural fit for accumulating view state. **Dynamic fan-out** (e.g. presence-per-user, a runtime-keyed signal set) is a *non-enumerable* write target and, in a view engine with a strict statically-analyzable write construct, falls to the uncapped escape hatch — a consumer-side classification, not an engine concern.

### 9.1 The third category: local-derived state (never offered to the seam)

A consumer's state divides three ways, not two:

1. **Durable** — persisted, replayed, synced.
2. **Ephemeral(ttl)** — synced live, never persisted, expires.
3. **Local-derived — never offered to `ns` at all.** Computed locally from synced state and meaningless to transmit: a form's validation errors / validating flag / submission count / validity; a view engine's derived nodes; a database's *composition* of confirmed-base-plus-pending (the inputs sync; the composed view does not).

This is **not an `ns` type** — the engine never sees this state — but the contract states it so consumers don't accidentally feed derived state into a feed. The rule: *if it can be recomputed locally from synced inputs, it is local-derived and never becomes a `Change`.* A consumer's adapter is responsible for this filter; the engine provides no mechanism because none is needed.

---

## 10. Out of scope (deferred to the `ns` implementation session)

- Concrete `ClockStrategy` implementations (HLC, vector, CRDT position).
- Concrete `Resolver` implementations beyond the interface.
- Concrete `Transport` implementations.
- CRDT internals, peer/mesh topology, persistence engine.
- Delivery guarantees: retry policy, backpressure, ack/redelivery (built atop the cursor/replay seam — see §7).
- The full pluggability *internals* behind `ClockStrategy` / `Resolver` / `Transport` — only their **boundaries** are frozen here.

---

> **Consumer handoff.** Resolving a specific consumer's local sync questions against this frozen surface is consumer-specific work, kept out of this spec. A consumer drops §1–§8 into its own sync seam, resolves its local equivalents, and re-runs its own reviewer checklist against the concrete contract.
