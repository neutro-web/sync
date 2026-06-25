# @neutro/sync (ns) — Founding Charter

> **Status:** Bootstrap. This charter is project knowledge for the `ns` claude.ai project —
> the orientation document every session reads to know *what ns is, what it isn't, and where
> it's going.* It sits alongside the **Seam Contract** (authoritative for semantics). Where
> this charter and the contract overlap, the contract wins on semantics; this charter wins on
> scope and direction. Open gates are marked **OPEN GATE** and must not be built past.

---

## 1. What ns is

`ns` is a **universal client-side sync layer**. One engine, configured per consumer, with
zero domain-specific code inside it.

**The mandate (one sentence):** *Sync is the reconciliation of two or more diverging replicas
of some state over an unreliable channel, where local progress must never block on the
channel.*

`ns` is the **seam**, not the storage and not the merge algorithm. It defines how changes
flow (`Feed`), how position is tracked (`Cursor`), how versions compare (`Version` via a
pluggable `ClockStrategy`), how durability is declared (`Lifetime`), how collisions surface
(`Conflict` → pluggable `Resolver`), how subscription partitions (`Scope`), and what a carrier
must satisfy (`Transport`). Everything domain-specific — what a value *is*, how it merges,
where it persists, which wire it crosses — is a consumer's or a strategy's concern, plugged
into a slot `ns` defines.

The proof that this generalizes: a reactive database, a reactive view engine, a reactive form
library, a shared-state store, queues, rich-text/canvas, presence, settings, and telemetry
all express as **knob settings on one engine** (Seam Contract §9). If a consumer needs bespoke
code inside `ns`, the abstraction is wrong.

### The five rulings that define the engine (T1–T5, frozen)

1. **T1 — One discriminated `Change`.** `state` ("field X is now Y", idempotent, latest-wins)
   and `op` ("do X", intent, dedup-by-id, ordered) flow through one feed. The `kind`
   discriminator encodes three coupled properties (`idempotent`, `replay`, `ordering`), not
   just payload shape. A single batch is heterogeneous — that's what makes "one pipe" real.
2. **T2 — Cursor / Version split.** `Cursor` (feed position) is `ns`-owned and concrete;
   `Version` (per-unit comparison) is strategy-owned and opaque. `ns`'s whole versioning role
   is `compare() → before | after | concurrent`. That three-valued compare is the entire
   generality: LWW, logical-clock merge, and CRDT all express through it.
3. **T3 — Lifetime in one pipe.** Every change is `durable` or `ephemeral(ttl)`. Ephemeral
   never advances the cursor, is never persisted, is never replayed — which is what lets
   presence and a database share one transport without either paying the other's cost.
4. **T4 — Detect, never decide.** `ns` builds a `Conflict` payload and hands it to a pluggable
   `Resolver`; it never reads `value`. `Resolution` is four-valued (`take-local | take-remote
   | merged | defer`); `defer` (open conflict held across time) is load-bearing.
5. **T5 — Per-scope causal order.** `ns` promises per-scope causal order and nothing stronger.
   Cross-scope total order is an explicit anti-promise — a coordinator would break the mandate.

---

## 2. What the primer is

In neutro, each project has a small set of **authoritative documents** that override any code
comment or summary. `ns`'s set (the "primer," collectively):

- **Seam Contract** (`docs/seam-contract.md`) — the frozen semantics: the eight seam types,
  T1–T5, the conformance checklist. Source of truth for *what ns means*. Versioned in its header.
- **Decision Log** (`docs/decision-log.md`) — Current-State header (locked / open / superseded)
  + append-only dated Log. Source of truth for *what is decided and why*.
- **Implementation State** (`docs/implementation-state.md`) — orientation digest of *what
  exists in code now* (file inventory, real/stub/deferred, the seams). Not authoritative over
  code (GitHub is); the first thing to read to avoid re-deriving the codebase.
- **This Charter** — scope and direction; what ns is/isn't, axioms, roadmap, session model.

The discipline (inherited from `nv`): read these before substantive work; never trust a prior
session's summary over them; if code conflicts with the contract, flag it — don't silently
follow either.

**Working rule across all sessions: BCon** — Be concise, plus no BS / no fluff / no sycophancy
/ only-valid / no-hallucinations / ground-every-assumption / steelman-then-find-the-leak.
Defined in full in the project custom instructions and `AGENTS.md`. It is tone and rigor, not a
substitute for the gate/spike/verification rules. (Type `BCon` in-session to refresh it.)

---

## 3. Performance, fault tolerance, efficiency, ergonomics, feature set

Framed as **targets and principles**, not yet as measured numbers. Per the tooling split
(§9), every number is a Claude-Code/CI deliverable; a sandbox number is noise.

### Performance (targets, to be measured on real hardware)
- **Local progress never blocks on the channel.** A local write applies and returns at memory
  speed; sync happens off the critical path. This is the mandate, not a tuning goal.
- **Replay is O(durable changes since checkpoint)** — independent of ephemeral volume (T3).
  Presence churn must not slow database replay.
- **Apply is O(batch)** with conflict detection O(1) per conflict-unit via `compare`.
- **No allocation in the hot apply/replay path** beyond the change objects themselves
  (mirrors `nv`'s data-structure discipline; to be verified, not assumed).

### Fault tolerance
- **Unreliable channel is the assumption, not the exception.** Drop, reorder, duplicate, and
  reconnect are normal inputs. `op` dedup-by-id and `state` idempotency make re-delivery safe.
- **Replay-from-cursor is the recovery primitive.** A replica that missed changes re-requests
  via `changes(since)`. Delivery guarantees (retry, ack, backpressure) live *above* the
  transport on this seam (§7), never inside the transport.
- **Conflicts are surfaced, never silently lost.** `defer` lets `ns` hold an unresolved
  conflict indefinitely rather than guess. Detect-not-decide is a fault-tolerance property,
  not just an API choice.
- **Ephemeral expiry is local and coordination-free.** Absence is the signal; no network
  message is needed for a TTL to lapse.

### Efficiency
- **One engine, not N.** Every consumer is configuration; there is no per-domain code path to
  maintain, test, or ship.
- **Ephemeral pays no durability cost; durable pays no ephemeral churn** (the T3 two-subsystem
  fork). This is the central efficiency claim of the design.
- **Versions are strategy-sized.** LWW carries a timestamp; CRDT carries a position. `ns`
  never imposes a versioning cost a consumer didn't opt into.

### Ergonomics
- **A consumer configures slots; it does not write protocol.** Pick a `kind` per change, a
  `lifetime`, a `ClockStrategy`, a `Resolver`, a `Transport`, a `Scope` granularity. Done.
- **The mixed consumer is natural, not special.** A form is durable field-state + ephemeral
  typing-indicator + a durable submit op, in one scope — because lifetime/kind live on the
  *change*, not the scope.
- **Better-together with reactive consumers**: `ns` is standalone, but a reactive engine can
  consume it — binding a feed to its reactivity through its own external-source seam, on the
  consumer's side. `ns` never depends on the consumer.

### Feature set (v-scoped; see roadmap §8)
- Core: `Change` (state+op), `Feed` (changes/snapshot/apply), `Cursor`/`Version`, `Lifetime`,
  `Conflict`/`Resolver`, `Scope` routing.
- Strategies: LWW, logical/hybrid clock, CRDT-position (pluggable; shipped as separate slot impls).
- Transports: in-process, BroadcastChannel (cross-tab), WebSocket, http-poll; WebRTC later.
- Persistence: durable change log + cursor (the replay substrate). Engine-pluggable.

---

## 4. What ns is NOT

- **Not a CRDT.** A CRDT is *one `Resolver` + `ClockStrategy` pairing* plugged into `ns`. The
  2026 landscape lesson (see §5): most apps don't need CRDT complexity — they need queued
  writes that sync. `ns` lets you choose LWW or dedup-by-id and never touch a CRDT, *or* plug
  one in for the rich-text scope only. `ns` does not privilege CRDTs.
- **Not a database / not storage.** `ns` defines the change log + cursor *seam*; the
  persistence engine behind it (IndexedDB, OPFS, memory) is pluggable and out of core.
- **Not a transport / not a server.** `ns` defines what a transport must satisfy; it ships
  concrete ones but is not tied to any. It is client-side; a server is one peer behind a transport.
- **Not a merge algorithm.** `ns` detects conflicts and routes them; the *decision* is the
  `Resolver`'s. `ns` never inspects a value.
- **Not a reactivity system.** Whether a landed change becomes a signal write is the consumer's
  concern. `ns` delivers changes; it does not own a graph. (`ns` is standalone — a reactive
  consumer may bind to it, but `ns` has no dependency on any reactivity system.)
- **Not a global-consensus / total-order system.** Per-scope causal order is the ceiling (T5).
  If you need cross-scope total order, collapse the scopes — `ns` won't coordinate it.
- **Not opinionated about value shape.** `value` is `unknown`. Rows, ops, positions, blobs —
  all opaque to `ns`.

---

## 5. Competitive landscape

> Verified June 2026. The space moves fast — re-verify before relying on any specific claim.

The 2026 framing has shifted from *"CRDT or OT?"* to *"which sync-engine boundary?"* The
practical, repeatedly-stated lesson: **CRDTs solve convergence but not collaboration**, and
**most offline-first apps just need queued writes that sync** — reaching for a CRDT is a
common over-engineering mistake. This is exactly the gap `ns` is shaped for.

**CRDT libraries** (Yjs, Automerge, Loro). These are *merge algorithms with a document model*.
Yjs is the production default (smallest bundle, largest ecosystem); Automerge offers a
Git-like change history (larger bundle); Loro (Rust/WASM, Fugue) is the performance/encoding
leader but youngest. **Relation to `ns`:** each is a candidate `Resolver`+`ClockStrategy` for a
single scope — not a competitor to the seam. `ns`'s value is letting an app use a CRDT *only
where it needs one* and LWW/dedup everywhere else, through one uniform pipe.

**Sync engines / frameworks** (Replicache, ElectricSQL "Electric Next", PowerSync, Liveblocks,
Y-Sweet, Logux, Fireproof, LiveStore). These bundle a transport + persistence + a server/cloud
boundary, often DB-coupled (Electric streams Postgres; PowerSync ships native SDKs). **Relation
to `ns`:** these are *fuller-stack and more opinionated*; `ns` is the thin, server-agnostic,
storage-agnostic seam beneath that layer. An `ns` consumer could be built to talk to one of
these as a transport.

**Reactive state libraries** (Legend-State, RxDB, Riffle-pattern stacks). Persist + sync a
reactive store. **Relation to `ns`:** overlaps the reactive-consumer use case; `ns` is the
sync seam such a library would configure against rather than reimplement.

**`ns`'s distinct position:** the **universal seam** — kind-agnostic (state *and* op), merge-
agnostic (LWW → CRDT pluggable), transport-agnostic, storage-agnostic, and lifetime-aware
(durable + ephemeral in one pipe). Nobody else's primary abstraction is "one engine all of
these configure against." The risk to name honestly (a gate for later, not now): a thin
universal seam must prove it doesn't become a lowest-common-denominator that's worse than a
purpose-built engine for any single consumer. That proof is the multi-consumer conformance suite.

---

## 6. What the API layer looks like

The **contract surface is frozen** (Seam Contract §1–§8): `Change`/`StateChange`/`OpChange`/
`VersionedChange`, `Cursor`/`Version`/`ClockStrategy`, `Lifetime`, `ChangeBatch`/`Snapshot`/
`Feed`, `Conflict`/`Resolution`/`Resolver`, `Scope`/`Subscription`/`ScopeRouter`, `Transport`,
and the opaque tokens. That is the *type seam* — what every consumer and strategy implements.

What is **NOT yet designed** (the public-facing API ergonomics layer on top of the seam):

> **OPEN GATE — Public API surface.** The seam contract is the *internal contract* between
> engine, strategies, transports, and consumers. The **consumer-facing convenience API** (how
> an app actually instantiates an `ns` client, registers scopes, attaches a transport and a
> resolver, and subscribes) is not yet specified. Do not freeze a public `createSync(...)` /
> client-builder shape until this gate is opened and worked. Sketches are welcome as design
> docs; a frozen API is not. (Mirrors `nv`'s open component-API gate discipline.)

The likely shape (sketch, not frozen): a client factory taking a `Transport` + per-scope
`{ ClockStrategy, Resolver, Lifetime defaults }`, exposing `subscribe(scope, handlers)` and a
local `apply`/emit path — but the exact builder ergonomics are the gate's job.

### Composition: vanilla TS + every framework (the binding model)

`ns` composes on **vanilla JS/TS as the primary surface** and **every frontend framework via
thin adapters** — both forced by the standalone axiom, `value:unknown`, and the
"subscription delivers changes" seam (not aspirational). Locked properties:

- **Plain-TS core.** The consumer-facing API is callbacks + promises; no framework type or
  reactivity primitive appears in any core signature. The vanilla API is the *real* API.
- **Three-primitive binding seam.** Every adapter maps the same three core operations —
  `subscribe(scope, handlers)`, `snapshot(scope)`, `emit`/local-write — onto a framework's
  native reactivity primitive (React `useSyncExternalStore`, Svelte store contract, Vue
  `shallowRef`, Solid/signals `{subscribe}`, Angular `Observable`/signal). Adapters hold **no
  sync logic**; one that needs to understand a `Change` or touch a `Cursor` means the core API
  is wrong.
- **Adapters are subpath exports** — `@neutro/sync/adapters/react`, `/adapters/svelte`, … on
  the single package; optional peer deps, independently tree-shakeable. (Charter §11, decision log.)
- **Still open under G2:** the `emit`/local-write ergonomics — discovered in design and
  implementation, not pinned now. Reusable analysis: design note `docs/design/framework-composition.md`.

---

## 7. Axioms

The non-negotiables. Violating one is a contract-level event (escalate; don't decide in-stream).

1. **Local progress never blocks on the channel.** The mandate. Everything else bends to this.
2. **One engine, zero domain code.** Every consumer is configuration. Bespoke code in core ⇒
   the abstraction is wrong.
3. **State and op are co-equal** (T1). Neither is privileged; both flow through one feed.
4. **`ns` detects, the resolver decides** (T4). `ns` never inspects `value`. Conflicts surface,
   never silently lost; `defer` is always available.
5. **`Version` is opaque to `ns`** (T2). The engine's only versioning act is `compare`. Clock
   semantics belong to the strategy.
6. **Ephemeral never touches the durable path** (T3). Never advances the cursor, never
   persisted, never replayed. The cursor counts only durable changes.
7. **Per-scope causal order is the ceiling** (T5). No global/total-order promise.
8. **Delivery guarantees live above the transport** (§7). The transport carries bytes; replay
   + cursor provide reliability.
9. **Slots stay narrow.** `Resolver`/`ClockStrategy`/`Transport` are not widened with
   coverage flags that dissolve the guarantee they exist to provide.
10. **Verify convergence on ≥2 replicas.** A sync property proven on one replica is unproven.

---

## 8. Detailed roadmap

Phased. Each phase ends at a gate; later phases may be reordered by what earlier phases find.
Dates omitted deliberately (this is a dependency order, not a schedule).

**Phase 0 — Bootstrap (this session + immediate follow-ups).**
Founding docs (charter, custom instructions, AGENTS.md), seam contract promoted into the repo,
decision-log + implementation-state seeded. Substrate **decided: ns is standalone** (no neutro
sibling dependency; consumers may use ns, ns depends on none). Exit: governance scaffold exists.

**Phase 1 — Reference engine (sandbox).**
Implement the core against the seam contract: `Change` application, `Cursor`/replay, conflict
detection via `compare`, `Scope` routing, the `Feed` (changes/snapshot/apply). In-process
`Transport` only. **Multi-replica convergence harness** (≥2 replicas, simulated unreliable
channel) is built *first* — it is the acceptance instrument, not an afterthought. Exit: two
in-process replicas diverge and reconcile correctly under drop/reorder/duplicate, verified.

**Phase 2 — Strategies (sandbox).**
LWW, logical/hybrid clock, and a CRDT-position strategy as pluggable `ClockStrategy`+`Resolver`
pairs. Each verified against the Phase-1 harness. Exit: the same engine, three strategies, all
converge; the "one engine generalizes" claim is demonstrated, not asserted.

**Phase 3 — Real transports + persistence (Claude Code / real hardware).**
Real BroadcastChannel (cross-tab), WebSocket, http-poll; durable change log on IndexedDB/OPFS
with replay-after-reload. First real throughput/latency numbers. Exit: cross-tab and
cross-device sync work on real hardware; replay survives a page reload; baseline numbers logged.

**Phase 4 — Public API + first consumer integration.**
Open and work the **Public API gate** (§6). Integrate against one real reactive consumer
through its external-source seam (consumer-side; ns stays standalone). Exit: an app instantiates `ns` and
syncs a real consumer end-to-end.

**Phase 5 — Hardening.**
Delivery guarantees above the transport (retry/backpressure/ack), conformance suite across all
declared consumer shapes (Seam Contract §9), the LCD-risk proof from §5. Exit: production-cand.

---

## 9. What prototypes here vs. what goes to Claude Code

The split is **"does the answer depend on a measured number or real-platform behavior?"**

**Builds in the claude.ai sandbox (the bulk of ns):**
- All change-application, cursor/replay, conflict-detection, and scope-routing *logic*.
- All `ClockStrategy` / `Resolver` *behavior* (compare semantics, merge correctness).
- **Multi-replica convergence simulation** under a *simulated* unreliable channel
  (drop/reorder/duplicate/partition) — deterministic, no hardware needed.
- Protocol design, spec authoring, the seam conformance suite's *logic*.

**Goes to Claude Code / CI (real hardware/browser):**
- Real `BroadcastChannel` cross-tab, real `WebSocket`/WebRTC behavior.
- Real persistence (IndexedDB/OPFS) durability + replay-after-reload.
- Every throughput / latency / memory **number**. A sandbox perf number is noise.
- Anything whose failure mode is real-platform-specific (tab lifecycle, storage eviction).

Rule of thumb: **correctness and convergence are deterministic → sandbox. Performance and
real-platform behavior → Claude Code.** Build correct-first, then fast.

---

## 10. The sandbox sessions we run

Mirrors the neutro multi-stream model; coordinated through the three authoritative docs.

- **Architect** — owns the seam contract + decision log; resolves gates; answers
  cross-cutting/contract questions. Does not implement in-stream. *This bootstrap is an
  architect session.*
- **Runtime** — the engine (`src/core`): change application, cursor/replay, conflict
  detection, scope routing. Built/verified against the contract and the convergence harness.
- **Compiler/strategies** — `ClockStrategy` + `Resolver` implementations. (Named to mirror the
  neutro stream set; ns has no `.nv`-style compile step.)
- **Integration** — proves multi-replica convergence composes across strategies and (later)
  real transports; owns no module; routes bugs back to the owning stream.

Plus **Claude Code** for real-hardware work (Phase 3+), per §9.

A session never invents an undecided decision; it halts at the gate and surfaces it (AGENTS.md).

---

## 11. Project structure & comparison to other neutro projects

`ns` follows the neutro house pattern, calibrated against `@neutro/view` (nv), `@neutro/form`
(nf), and `@neutro/fluid`.

**Shared house pattern (all neutro projects):**
- `CLAUDE.md` → points to `AGENTS.md` (working-instructions source of truth).
- `AGENTS.md` → how agents/contributors work; locked decisions; workstreams; gates.
- `docs/` → authoritative semantics doc + decision log + (where mature) implementation-state.
- `docs/superpowers/plans/` + `docs/superpowers/specs/` → session plans and specs (seen in
  nv, nf, fluid).
- Single published package with **subpath exports** — one version, one build, one release.
- Strict tooling: `tsc --strict` and tests are **separate gates**; biome lint; lefthook
  pre-push; release-please.
- Discipline: halt-at-gates, spike=executed-verification, GitHub-authoritative-for-code,
  done=committed-on-main.

**Where each differs (so ns knows which it resembles):**
- **nv** — the most governance-mature: full triad (`reactive-core-contract.md` +
  `decision-log.md` + `implementation-state.md`) plus `docs/gates/`, `docs/design/`, a `bench/`
  for real-hardware perf, and an `integration/` gate dir. **ns should mirror nv most closely**
  — it has the same "frozen semantics contract + multi-session coordination + sandbox-vs-real-
  hardware split" shape. ns's convergence harness ≈ nv's conformance suite + bench.
- **nf** — multi-package (`packages/`), VitePress docs site (`docs/api`, `docs/guides`),
  changelog/license present (more release-ready). ns will resemble nf when it reaches a public
  docs site, but starts single-package like nv.
- **fluid** — a component library (turbo monorepo, `apps/`, `packages/`, per-component docs).
  Structurally the least like ns (it's a UI kit, not an engine). ns takes fluid's monorepo
  tooling cues only if it later splits into many packages — not at bootstrap.

**ns's structure (decided — standalone, single package, subpath exports):**
```
ns/
  CLAUDE.md                    → points to AGENTS.md
  AGENTS.md                    → working instructions (house pattern, ns-tuned)
  docs/
    seam-contract.md           → frozen semantics (the Seam Contract)
    decision-log.md            → Current-State + append-only Log
    implementation-state.md    → code-facts digest (seeded empty)
    design/                    → reusable design docs
    gates/                     → acceptance gates (per nv)
  src/
    core/                      → @neutro/sync/core (engine; standalone, no neutro-sibling dep)
    strategies/                → @neutro/sync/strategies (ClockStrategy + Resolver impls)
    transports/                → @neutro/sync/transports (Transport impls)
    adapters/                  → @neutro/sync/adapters/<framework> (thin: react, svelte, vue, …)
  test/                        → mirrors src/; convergence tests use ≥2 replicas
  integration/                 → multi-replica + real-transport composition
```

---

## 12. Open gates (standing list — do not build past)

> **Resolved 2026-06-24 — Substrate:** `ns` is **standalone** (no neutro-sibling dependency;
> consumers may use `ns`, `ns` depends on none). This was briefly an open gate during bootstrap;
> it is now locked. See the decision log.

1. **Public API surface** (§6) — the consumer-facing client/builder ergonomics on top of the
   frozen seam. Blocks Phase 4. Sketch freely; do not freeze.
2. **LCD-risk proof** (§5) — demonstrating the universal seam isn't worse than a purpose-built
   engine for any single consumer. Not blocking early phases; the conformance suite addresses it.

This session does not resolve these. It establishes the scaffold in which they get resolved,
one dated decision-log entry at a time.
