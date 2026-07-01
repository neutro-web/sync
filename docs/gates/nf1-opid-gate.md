# Acceptance Gate: NF-1 — consumer-supplied op id (`WriteOpts.opId`)

> **Gate version**: 1.0. **Stream**: Runtime (public client). **Origin**: nf integration spike
> (2026-06-30) Finding 1 — `do()` mints op ids internally, so a consumer cannot make an op
> idempotent across redelivery; a redelivered op double-applies (proven `APPLIED_COUNT=2`).
> **Predecessor**: main HEAD `4660565` (Phase 3 transports). **Sandbox-appropriate** — pure client
> logic, deterministic, no hardware.
>
> **Contract verification (done, not assumed):** additive and seam-clean.
> - `ChangeId` is already a public token (`src/core/types.ts`, `makeChangeId`); the contract requires
>   `id` "globally unique... required for op dedup" (§1 `ChangeBase`) but does **not** constrain *who
>   mints it*. Consumer-supplied vs client-minted is invisible to the engine (dedup is on
>   `change.id.value`, a string).
> - **T1 aligned, not strained**: T1's op rule is "dedup by `id`." A stable consumer op id
>   *strengthens* dedup (redelivery collapses); the current auto-counter *defeats* it. This fix
>   restores T1's intent.
> - **§7 untouched**: client-surface change only; `send` still resolves on hand-off; retry stays
>   above the transport (Phase 5). This lets a consumer *build* that retry; it does not build it.
> - **No seam-file change**: seam v1.1 stays frozen. `docs/seam-contract.md`, `src/core/types.ts`,
>   `src/core/engine.ts` unchanged.

---

## The change (verified drop-in — typechecks and behaves, tested in-session)

**`src/client/create-sync.ts`**, two edits:

1. Add `opId` to `WriteOpts`:
   ```ts
   export interface WriteOpts {
     lifetime?: Lifetime;
     unitKey?: string;
     /** Stable op id for dedup across redelivery (op/`do` only). Consumer owns
      *  uniqueness-per-logical-op. Absent → auto-minted (current behavior). */
     opId?: string;
   }
   ```

2. In `do()`, use it when present (the ONLY line that changes in the method body):
   ```ts
   // before:
   id: makeChangeId(`${_clientId}:${key}:do:${unit}:${++_seq}`),
   // after:
   id: makeChangeId(opts?.opId ?? `${_clientId}:${key}:do:${unit}:${++_seq}`),
   ```

**Scope: `do()` only.** `set()` (state) is deliberately NOT changed — state dedup is by version, not
id, and re-emitting state is already idempotent (spike Finding 2). Adding `opId` to `set()` is surface
with no benefit.

---

## Gate items (each failable)

### NF1-1 — `opId` present → redelivery dedups to exactly one application

**Command**: `pnpm test` → `test/client/op-id.test.ts` → "NF1-1 · stable opId dedups redelivery"

**Setup**: 2 clients, reliable in-process pair (isolate from drop-luck). Client A calls
`sA.do("submit", {p:1}, {opId: "A:submit:1"})` **twice** with identical opId. B subscribes, counts
op applications.

**Asserted end-state**: B applies the op **exactly once** (`count === 1`). Verified in-session:
`withOpId_deduped=true`.

**Failure condition**: B applies twice (opId ignored / dedup not wired).

### NF1-2 — `opId` absent → current behavior preserved (back-compat)

**Command**: `pnpm test` → `op-id.test.ts` → "NF1-2 · no opId preserves auto-mint"

**Setup**: same, but `sA.do("other", {q:9})` twice with **no** opId.

**Asserted end-state**: B applies **twice** — distinct auto-minted ids, exactly as before this change.
Verified in-session: `backcompat_distinct=true`. (This is not a bug; it documents that without a
stable id, two `do()` calls are two distinct ops.)

**Failure condition**: absence of opId changes prior behavior (e.g. accidental dedup by unit).

### NF1-3 — distinct ops sharing an `opId` → second is dropped (documented consequence, not silent trap)

**Command**: `pnpm test` → `op-id.test.ts` → "NF1-3 · opId collision drops the second op"

**Setup**: `sA.do("x", {v:1}, {opId:"dup"})` then `sA.do("x", {v:2}, {opId:"dup"})` — two *different*
payloads, same opId.

**Asserted end-state**: B applies only the first (`{v:1}`); the second is deduped away. The test
**asserts this explicitly** so the uniqueness-ownership contract is captured as tested behavior, not
discovered in production. JSDoc on `opId` states "consumer owns uniqueness-per-logical-op."

**Failure condition**: both apply (dedup not by id) OR the behavior is undocumented (no JSDoc, no test).

### NF1-4 — 2-replica op convergence under fault injection, driven by `opId` redelivery

**Command**: `pnpm test` → `op-id.test.ts` → "NF1-4 · opId redelivery converges under faults"

**Replica count**: 2

**Divergence driver**: A emits a durable op with a stable `opId`; the channel drops (30%) + duplicates.
A re-emits the **same opId** on a drain tick until B has it (the reliability pattern the spike proved).

**Reconciled assertion**: after drain, B has applied the op **exactly once** despite N re-emits and
channel duplication; no divergence. This is the spike's Finding-1 workaround now backed by the API
instead of a `__idem`-in-value hack.

**Failure condition**: op applied >1× (dedup broken under redelivery) OR never arrives (test wrong).

---

## Standing gates
`pnpm typecheck` (0 — verified in-session) · `pnpm test` (existing 151 stay green + new) ·
`pnpm lint` (0). **Regression guard**: `docs/seam-contract.md`, `src/core/types.ts`,
`src/core/engine.ts`, `test/harness/` unchanged (`git diff --name-only` empty).

---

## Summary table

| Item | Replicas | Driver | Asserted |
|---|---|---|---|
| NF1-1 | 2 | same opId ×2, reliable | applied exactly once |
| NF1-2 | 2 | no opId ×2, reliable | applied twice (back-compat) |
| NF1-3 | 2 | distinct payloads, same opId | only first applies; documented |
| NF1-4 | 2 | opId redelivery under faults | exactly once, converges |
| std | — | — | typecheck/test/lint 0; seam+engine+harness unchanged |

---

## Doc reconciliation (apply in CC)
- **Decision-log**: append a dated entry resolving **NF-1** (cite the nf spike finding); move NF-1
  from "Open gates" to resolved in Current-State.
- **implementation-state.md**: note `WriteOpts.opId` on the `create-sync.ts` row.
- **nf-integration-spike design doc**: update Finding 1 — resolution is option (a), landed; the
  `__idem`-in-value pattern is now unnecessary (the API backs it).
