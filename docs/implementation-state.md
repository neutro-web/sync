# ns — Implementation State Map

**What this is.** A one-page orientation digest of *what exists in the code right now* — file
inventory, real-vs-stub status, the load-bearing seams, and known gaps. It exists because the
decision log records **decisions** and the seam contract records **semantics**, but neither
records **code facts**. Re-deriving those each session causes churn; this file holds them.

**What this is NOT.** Not a decision record (those go in `decision-log.md`), not a semantics
spec (that is `seam-contract.md`), and **not authoritative** — **GitHub is authoritative for
code.** This is a navigational summary, regenerated when reality moves. If it disagrees with
the source, the source wins and this file is stale → fix it.

**Maintenance.** Update in the same pass that lands code, as a ready-to-commit edit (same
discipline as log entries). Keep it to roughly this length; detail belongs in the code.

Last verified against source: **2026-06-24 (bootstrap — no code yet).** Seam Contract **v1.0**.

---

## Status: PRE-CODE

There is **no `src/` yet.** The project is at Phase 0 (bootstrap): the governance scaffold and
founding docs exist; the reference engine (Phase 1) has not started. This file is a seeded
skeleton to be filled in the same pass as the first code lands.

---

## File inventory (status per file)

Legend: **REAL** = production-complete & verified · **PARTIAL** = works for a subset ·
**STUB** = placeholder/not-runnable · **DEFERRED** = designed, not built · **—** = not created.

### Governance / docs (exist now)
| File | Status | Notes |
|---|---|---|
| `docs/seam-contract.md` | REAL | Frozen seam semantics, v1.0. The eight seam types + T1–T5 + §9 consumer map + §9.1 local-derived rule. Authoritative for semantics. |
| `docs/decision-log.md` | REAL | Current-State + append-only Log. T1–T5 + standalone locked; G2–G3 open. |
| `docs/implementation-state.md` | REAL | This file. |
| `AGENTS.md` | REAL | Working instructions (house pattern, ns-tuned). Substrate locked: standalone. |
| `CLAUDE.md` | DEFERRED | One-liner pointing to AGENTS.md (to be added with repo init). |
| Founding Charter | REAL | Project-knowledge orientation (lives in the claude.ai project knowledge; may be mirrored into `docs/` at repo init). |

### `src/core/` → `@neutro/sync/core` (the engine)
| File | Status | Notes |
|---|---|---|
| change application / `Feed.apply` | — | Phase 1. Branches on `kind`: idempotent state; dedup-by-id op; op-with-version fold + conflict. |
| cursor / replay (`changes`) | — | Phase 1. Durable-only cursor advance; replay-from-checkpoint. |
| snapshot (`snapshot`) | — | Phase 1. Current-state-on-subscribe (ephemeral + memoryless-transport durable). |
| conflict detection | — | Phase 1. Calls `ClockStrategy.compare`; builds value-opaque `Conflict`; routes to `Resolver`. |
| scope routing (`ScopeRouter`) | — | Phase 1. Per-scope causal-order subscription. |

### `src/strategies/` → `@neutro/sync/strategies`
| File | Status | Notes |
|---|---|---|
| LWW `ClockStrategy` + resolver | — | Phase 2. |
| logical/hybrid clock | — | Phase 2. |
| CRDT-position strategy | — | Phase 2. |

### `src/transports/` → `@neutro/sync/transports`
| File | Status | Notes |
|---|---|---|
| in-process transport | — | Phase 1 (needed for the convergence harness). |
| BroadcastChannel | — | Phase 3 (real hardware). |
| WebSocket / http-poll | — | Phase 3 (real hardware). |

### `src/adapters/` → `@neutro/sync/adapters/<framework>` (subpath exports)
| File | Status | Notes |
|---|---|---|
| react / svelte / vue / solid / angular | — | Phase 4. Thin: map `subscribe`/`snapshot`/`emit` → framework primitive; no sync logic. Optional peer deps; each subpath independently tree-shakeable. Blocked on G2 write/emit ergonomics. |

### `test/` + `integration/`
| File | Status | Notes |
|---|---|---|
| multi-replica convergence harness | — | **Phase 1, built first.** ≥2 replicas over a simulated unreliable channel (drop/reorder/duplicate/partition). The acceptance instrument. |
| seam conformance suite | — | Phase 2+. Exercises each §9 consumer shape as knob settings. |

---

## Load-bearing seams (once code exists, list real signatures here)

To be filled as Phase 1 lands. Each entry should name the real signature, what's real vs. stub,
and what it discards — so a future spec composes against facts, not inferred internals. Expected
seams: `Feed.apply` ⟷ `ClockStrategy.compare` ⟷ `Resolver.resolve`; `Feed.changes` ⟷ cursor
store; `Transport.send/receive` ⟷ `Feed.apply`; `ScopeRouter.subscribe` ⟷ feed delivery.

---

## Known gaps / defects

- _(none — no code yet)_

---

## Open gates affecting code (mirror of decision-log Current State)

- **Standalone (locked)** — no `neutro/*` runtime dependency ever enters `src/core`. A reactive
  consumer binds to `ns` on its own side; there is no `ns`-side adapter package in core scope.
- **G2 Public API** — do not create a frozen public client/builder; sketches are design docs.
- **G3 LCD-risk** — the conformance suite is the eventual evidence; not blocking Phase 1.
