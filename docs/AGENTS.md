# Working instructions for @neutro/sync (ns)

A universal client-side sync layer: the reconciliation of two or more diverging replicas of
some state over an unreliable channel, where local progress never blocks on the channel.
This file is the source of truth for how agents and contributors work in this repo.
(`CLAUDE.md` points here.)

## What this project is

Three documents are authoritative and override any code comment or other doc:

- `docs/seam-contract.md` — source of truth for the **sync seam semantics** (the `Change`
  / `Feed` / `Cursor` / `Version` / `Lifetime` / `Conflict` / `Scope` / `Transport`
  surface, the T1–T5 rulings, and the conformance checklist). This is the frozen seam
  spec; the contract version is tracked in its header.
- `docs/decision-log.md` — source of truth for **what is decided and why**.
- `docs/implementation-state.md` — orientation digest of **what exists in the code now**
  (file inventory, real-vs-stub status, the load-bearing seams). It is *not* authoritative
  over the code — **GitHub is authoritative for code** — but it is the first thing to read
  to avoid re-deriving the codebase's current shape from scratch.

If code or discussion conflicts with the contract, flag the conflict explicitly; do not
silently follow either.

## Before doing substantive work

1. Read the decision log's **Current State** header (what is locked / open / superseded).
2. Read `docs/implementation-state.md` (what is real / stub / deferred, and the seams).
3. Consult the dated Log only for the rationale behind a decision.

Do not trust a prior-session summary or hand-off note over these files or over the source
itself; summaries are lossy. Re-establish code facts from `implementation-state.md` + the
actual source, not from recollection.

## Read the seams before you spec

Before writing a spec or design that **composes existing modules** (e.g. "a transport that
feeds `Feed.apply`", "a resolver consuming a `Conflict`"), read the actual source of every
seam you are composing — signatures, return types, what is real vs. stub, what it discards.
Do not spec against inferred internals. A spec built on a guess about a seam is a spec that
will be revised once the guess is checked; reading first collapses the revision loop. This
is distinct from (and in addition to) verifying external library claims.

## Halt at an undecided design gate — do not invent the decision

If executing a task requires a decision that has **not been made** (it is not in the locked
list, not resolved in the log, and is flagged "open" or "not yet specified" anywhere), stop
at that boundary and surface it. Do **not** silently pick a default and build past it. A
task may proceed *up to* the gate — building the parts that don't depend on the undecided
piece — but must structure the work so the missing decision can be filled in later without a
rewrite, and must name the gate it stopped at. Fabricating an unmade decision is the costlier
error; it looks like progress and has to be unwound.

## "Spike" means executed verification, not analysis

A *spike* runs throwaway code and reports what executed. A document that reasons about
options — tiers, tradeoffs, proposed forms — is a *design doc*, not a spike; do not call it
one. Do not mark anything "verified" on the strength of a stub or a structural argument: if
a claim is about real-engine behavior (convergence, replay correctness, conflict
detection under concurrency), it must run against the real module before it is logged as
verified. "Structurally sound" is a hypothesis; only execution closes it.

> **ns-specific sharpening.** A convergence or conflict-detection claim proven against a
> single in-process replica is *not* verified — those properties are about **two or more
> replicas diverging and reconciling**. A spike that does not instantiate ≥2 replicas and
> drive them apart over a (simulated) unreliable channel has not tested the property it
> claims. Single-replica green is the sync-layer equivalent of `expect(true).toBe(true)`.

## Three artifact kinds, three fates

- **Design doc** (reusable analysis, deferred-work ledger, worked forms) → lives in
  `docs/design/`; referenced by the decision-log entry. Kept because a future session
  re-reads it to make a decision or to pick up deferred work.
- **Decision-log entry** → records the *event/finding* only (what was decided/verified and
  why), not the reusable analysis. Append-only.
- **Session instruction** (a brief handed to another session) → scaffolding. Once its
  output is folded into a design doc or the log, **discard it** — do not file it in
  `docs/design/`. Filing spent instructions clutters the durable-reference directory.

When unsure which an artifact is, ask: *would a future session re-read this to make a
decision?* → design doc. *Is it the record that a decision happened?* → log. *Was it a
one-shot hand-off whose output is now captured elsewhere?* → discard.

## Decision-log workflow

When work reaches a decision (locks something, opens a question, supersedes a prior call,
or resolves a research finding): append a new **dated** entry to the Log **and** update the
Current State header. Append-only — never rewrite history; record reversals as new entries
citing the superseded entry's date. If a decision changes the contract, note the contract
version bump in the entry. When the Log grows unwieldy, move stale entries to
`docs/decision-log-archive.md` with a one-line pointer left behind.

When a change lands code that alters the inventory or a seam, update
`docs/implementation-state.md` in the same pass (it is orientation, not history — edit it in
place; do not append-and-date it like the log).

## Locked architectural decisions (do not drift without explicit reversal)

These are ratified by the frozen seam contract (T1–T5). Reversing one is a contract
version bump, not an in-stream change.

- **One discriminated `Change` type** (T1). The `kind` discriminator encodes three coupled
  properties — `idempotent`, `replay`, `ordering` — not just payload shape. `state` and
  `op` are the two presets. A single batch is heterogeneous; do **not** split into
  `Feed<StateChange>` / `Feed<OpChange>` or two feeds.
- **Cursor / Version split** (T2). `Cursor` (feed position) is `ns`-owned and concrete;
  `Version` (per-unit comparison token) is strategy-owned and **opaque to `ns`**. `ns`'s
  entire versioning involvement is `ClockStrategy.compare() → before | after | concurrent`.
  Do not let `ns` read inside a `Version`.
- **Lifetime gates two subsystems** (T3). Ephemeral changes **never** advance the cursor,
  are never persisted, are never replayed. The cursor counts only durable changes — this
  is the guarantee that keeps replay cost independent of ephemeral volume. Do not erode it.
- **Detect, never silently decide** (T4). `ns` builds the `Conflict` payload and hands it
  to a pluggable `Resolver`; it never inspects `value`. The four-valued `Resolution`
  (`take-local | take-remote | merged | defer`) is the whole range; `defer` (open conflict
  held across time) is load-bearing and must be tolerated by contract.
- **Per-scope causal order only** (T5). `ns` promises per-scope causal order and nothing
  stronger. Cross-scope total order is an explicit **anti-promise** (a coordinator would
  violate "local progress never blocks on the channel"). Do not add a global-order promise.
- **Delivery guarantees live above the transport** (§7). `Transport.send` resolves on
  hand-off, not ack. Retry, backpressure, and ack/redelivery are built on the cursor/replay
  seam, not pushed into the transport contract.

## Strictness rules (the constructs stay narrow)

- The `Resolver` / `ClockStrategy` / `Transport` boundaries are **slots**, not extension
  points to widen. Do not add coverage-widening flags that dissolve the guarantee a slot
  exists to provide (mirrors `nv`'s strict-`sync` discipline).
- `value` is `unknown` to `ns` everywhere. No domain type ever leaks into the core. A
  consumer casts; `ns` never does.
- Local-derived state is never a `Change`. If a consumer can recompute it from synced
  inputs, it must not enter a feed. `ns` provides no mechanism for this because none is
  needed — it is a consumer-adapter responsibility, stated so it is not violated by accident.

## Substrate — LOCKED: ns is standalone

`ns` is **standalone**, like every neutro package. It has **no dependency on any neutro sibling**
(including `nv`). Other libraries — a reactive view engine, a reactive database, a form library —
**may consume `ns`**, but `ns` never depends on them. No `neutro/*` runtime import ever enters
`src/core`. A reactive consumer binds a feed to its reactivity on *its own* side, through `ns`'s
public surface; there is no `ns`-side adapter to a specific consumer in core scope. The seam
contract is consumer- and transport-agnostic precisely so this holds.

## Repo shape (decided)

Mirrors the neutro house pattern (single published package, subpath exports, one version /
build / release — as in `@neutro/view` and `@neutro/form`):

- `src/core/` → published as `@neutro/sync/core` (the engine: `Change`/`Feed`/`Cursor`/
  conflict detection / scope routing). Standalone; built against the seam contract; no
  `neutro/*` runtime import.
- `src/transports/` → `@neutro/sync/transports` (concrete `Transport` implementations:
  BroadcastChannel, WebSocket, http-poll, in-process). Each satisfies the §7 contract.
- `src/strategies/` → `@neutro/sync/strategies` (concrete `ClockStrategy` + `Resolver`
  implementations: LWW, logical/hybrid clock, CRDT position; LWW / merge-fn / manual resolvers).
- `src/adapters/` → `@neutro/sync/adapters/<framework>` (subpath exports: `react`, `svelte`,
  `vue`, `solid`, `angular`, …). Each adapter is **thin** — it maps the three core primitives
  (`subscribe`/`snapshot`/`emit`) onto a framework's native reactivity primitive and holds **no
  sync logic** (no cursor, no conflict policy, no transport). An adapter that needs to understand
  a `Change` or touch a `Cursor` means the core API is wrong — escalate, don't thicken the adapter.
  - **Build requirements (gate items, not free):** framework peers are declared **optional peer
    dependencies** (`peerDependenciesMeta.optional`); each adapter subpath is **independently
    tree-shakeable** so importing `/adapters/react` pulls no other adapter's code and requires no
    other framework installed. The core API itself is plain TS — no framework type in any core
    signature; adapters are strictly additive over it.
- `test/` mirrors `src/`. Convergence/replay tests **must instantiate ≥2 replicas** (see the
  spike rule above).
- `integration/` holds cross-concern tests (multi-replica + real-transport); owns no module.
- `docs/` holds the seam contract, decision log, implementation-state map, and design notes.

### Import style (decided — apply consistently, mirrors `nv`)

- **Inside `src/` (and tests), use relative imports**, extensionless
  (`moduleResolution: "bundler"`). Cross-concern internal imports are relative too.
- **The `@neutro/sync/*` aliases are the external/published surface only** — declared in
  `package.json` `exports` and the `src/*/index.ts` barrels. Do not use them for internal source.
- A genuinely orthogonal future concern becomes its **own package**, not a subpath.

## Workstreams (keep distinct; note which one a change serves)

Mirrors the neutro multi-stream model. The sandbox/Claude-Code split is in **Tooling** below.

1. **Architect** — owns the seam contract + decision log; cross-references for
   architectural/contract questions; resolves gates. Does not implement in-stream.
2. **Runtime** (`src/core`) — the engine: change application, cursor/replay, conflict
   detection, scope routing. Built and verified against the seam contract.
3. **Compiler/strategies** (`src/strategies`) — `ClockStrategy` and `Resolver`
   implementations. (Named "compiler" loosely to mirror the neutro stream set; `ns` has no
   `.nv`-style compile step.)
4. **Integration** (`integration/`) — proves multi-replica convergence over real transports;
   owns no module; routes any bug back to its owning stream rather than fixing in place.

## Escalation calibration

A question is contract-level (escalate; don't decide in-stream) if it touches a locked
T1–T5 ruling, the §7 delivery-above-transport boundary, or changes what `ns` promises about
ordering/convergence — even if it feels like an implementation detail. For a strategy
specifically: if a `ClockStrategy` or `Resolver` choice can produce a **wrong convergence
result** (divergent replicas that never reconcile, or a silently-dropped conflict) rather
than just slower reconciliation, that is a contract violation — escalate. A question is also
gate-level (surface it) if answering it requires making a design decision flagged open or
unspecified — the **Public API gate** is the current standing example. Pure layout, helper
organization, and import organization are in-stream. When unsure, surface it;
under-escalating is the costlier error.

## Acceptance gates

Every non-trivial feature landing is verified against a filled-in gate file in
`docs/gates/`, derived from the approved design *before* implementation starts. The gate is
the acceptance contract: it states what evidence proves "done." Completion is read back
against placed files on main's HEAD, not summaries or green counts. Every gate item must be
able to fail: name the specific artifact/command that produces the evidence and the exact
condition that would make it fail. A convergence gate item must specify the replica count,
the divergence driver, and the reconciled end-state asserted.

## Two standing gates (separate, both required)

`tsc --strict` and the test suite are **separate gates**. The test runner strips types, so
a green suite does **not** imply a clean compile. Both run on `pre-push` (lefthook) and in CI:

```bash
pnpm typecheck   # tsc --strict
pnpm test        # vitest (multi-replica where convergence is claimed)
pnpm lint        # biome
pnpm build       # emit dist/
```

## Done means committed and on main

A task is not "done" when files are written — only when its changes are **committed and
pushed to main** (or an explicit PR), verified by `git log` / `git show` on **main's HEAD**,
not on a worktree. An agent that writes files without committing produces zero branch
divergence, so a merge is a silent no-op. Treat "Already up to date" as a red flag to
investigate, not success. The same distrust applies to a worktree's copy of
`implementation-state.md` — reconcile it against main, not the worktree.

## Tooling / where work happens

Correctness, logic, and protocol analysis are deterministic and prototype in the **claude.ai
sandbox**: change-application logic, cursor/replay correctness, conflict detection, resolver
behavior, and **multi-replica convergence under a simulated unreliable channel** all run as
in-process simulations with no real hardware. This is the bulk of `ns` and it builds here.

**Real-hardware / real-browser work happens in Claude Code and CI:** real `BroadcastChannel`
cross-tab behavior, real `WebSocket`/WebRTC transport, real persistence (IndexedDB/OPFS)
durability and replay-after-reload, and any **throughput/latency number**. The trigger to
treat something as a real-hardware question is "the answer depends on a measured number or
real-platform behavior," not "feels hairy." A sandbox throughput number is noise; never ship
a transport or strategy as "faster" on the strength of one.

**Measurement-semantics discipline.** A change to *what a measurement isolates* (what counts
as "converged," what is in the timed region, the denominator) is a measurement-semantics
change — surface it explicitly, even when it improves the instrument. An unreported
improvement looks like compliance with the original spec when it isn't.

## Working style — the BCon rule

**BCon = "Be concise," carrying all of the following. It is the default working contract for
this repo across discussion, design, and implementation. A contributor may type `BCon` to
refresh it mid-session.**

- **Concise.** Shortest response/PR/comment that fully does the job. No padding, no preamble,
  no restating the task. Length tracks the problem.
- **No BS / no fluff.** Every sentence does work.
- **No sycophancy.** Agreement is earned by the argument, not offered as lubricant.
- **Only valid.** State what holds; bound what's uncertain; never present a guess as a fact.
- **No hallucinations, ever.** Do not invent APIs, signatures, library behaviors, benchmarks,
  citations, or decisions. Unverified ⇒ not stated as true. (Reinforces "read the seams before
  you spec" and "verify by running, not reading.")
- **Double-check assumptions; ground them** in a practical truth, a verified source, or a
  realistic mechanism — not recollection.
- **Steelman, then find the leak.** Strongest form first, then where it breaks. Negative/null
  results are valid findings.
- **Own mistakes and fix them** without self-abasement.

BCon is the tone and rigor in which the rest of this file's rules are delivered; it does not
override halt-at-gates, spike discipline, or external-claim verification. Distinguish decided /
open-decision / genuine-research; don't relitigate settled decisions unless new information
changes them. The sync / CRDT / local-first space moves fast — verify, don't assert from memory.
