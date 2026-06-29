# Phase 2/3 Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three threads of carried debt before Phase 3 starts — confirm P8/P9 are landed (they are, already green), fix the stale `_applyOp` concurrent-arm comment, document the resolver-determinism convergence expectation in the seam contract, and update the three living docs.

**Architecture:** P8 and P9 tests already exist and pass (40/40). The only code change is a one-line comment fix in `src/core/engine.ts`. Everything else is prose additions to `docs/seam-contract.md`, `docs/implementation-state.md`, and `docs/decision-log.md`, plus a one-line cross-ref in `src/core/resolver-pump.ts`.

**Tech Stack:** TypeScript, Vitest, pnpm. No new dependencies.

## Global Constraints

- `src/core/types.ts` is FROZEN at v1.0 — do not touch it. If any edit to types.ts seems needed, STOP and escalate.
- `test/harness/` files must not be modified.
- `src/strategies/lww.ts` must not be modified.
- 40 existing tests must stay green (`pnpm test`); `tsc --noEmit` must stay clean.
- No new engine logic. The only src/ changes are a comment fix in `engine.ts` and a JSDoc line in `resolver-pump.ts`.
- seam-contract.md §5 addition is a **stated expectation** (prose), not a type change. The `Resolver` interface is unchanged.
- BCon: no fluff in commit messages or docs — only valid assertions.

---

## File Map

| File | Change |
|------|--------|
| `src/core/engine.ts` | Line ~245: fix stale comment `"Phase 2 will route to Resolver"` → `"Phase 3 will route (op path)"` |
| `src/core/resolver-pump.ts` | Add one-line cross-ref to seam-contract §5 determinism expectation in class JSDoc |
| `docs/seam-contract.md` | Add determinism paragraph after the Anti-leak callout in §5 (before `---` separator to §6) |
| `docs/implementation-state.md` | Record resolver-determinism expectation under conflict seam row; confirm P8/P9 rows are accurate |
| `docs/decision-log.md` | Append 2026-06-28 consolidation entry: P8/P9 confirmed landed; determinism expectation documented; `merged`/op-path deferred to Phase 3 |

---

### Task 1: Fix stale `_applyOp` comment + add resolver-pump cross-ref

**Files:**
- Modify: `src/core/engine.ts` (line ~245)
- Modify: `src/core/resolver-pump.ts` (class JSDoc)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: two clean source files for Task 2's doc update

- [ ] **Step 1: Read engine.ts and find the stale comment**

Run:
```bash
grep -n "Phase 2 will route" src/core/engine.ts
```
Expected output: something like `245:          // T4 deferred (unreachable under LWW). Phase 2 will route to Resolver.`

- [ ] **Step 2: Fix the stale comment in engine.ts**

Find this exact block in `src/core/engine.ts` (inside `_applyOp`, the `cmp === "concurrent"` arm):

```typescript
        if (cmp === "concurrent") {
          // T4 deferred (unreachable under LWW). Phase 2 will route to Resolver.
          // Do NOT add to seenIds — leave open for re-routing.
          return false;
        }
```

Replace with:

```typescript
        if (cmp === "concurrent") {
          // T4 deferred — op path stays deferred. Phase 3 will route (op path
          // carries Version only, not VersionedChange; concurrent routing
          // requires VersionedChange to build a Conflict payload).
          // Do NOT add to seenIds — leave open for re-routing.
          return false;
        }
```

- [ ] **Step 3: Add cross-ref line to resolver-pump.ts class JSDoc**

In `src/core/resolver-pump.ts`, find the class JSDoc above `export class ResolverPump`. It currently ends with this line:

```typescript
 * Async resolvers: `onConflict` returns `{ decision: "defer" }` synchronously;
 * the promise settles and calls `resolveConflict` later.
 */
export class ResolverPump {
```

Insert one new line between the async-resolver sentence and the closing `*/`:

```typescript
 * Async resolvers: `onConflict` returns `{ decision: "defer" }` synchronously;
 * the promise settles and calls `resolveConflict` later.
 *
 * **Convergence requirement:** for local (non-propagated) resolution, the
 * `Resolver` passed here MUST be a deterministic pure function — see
 * `docs/seam-contract.md` §5 for the full expectation.
 */
export class ResolverPump {
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm test && pnpm exec tsc --noEmit
```

Expected: `Tests  40 passed (40)`, no tsc errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts src/core/resolver-pump.ts
git commit -m "fix(engine): stale _applyOp concurrent comment Phase 2→Phase 3; resolver-pump seam-contract cross-ref"
```

---

### Task 2: Add resolver-determinism expectation to seam-contract.md

**Files:**
- Modify: `docs/seam-contract.md`

**Interfaces:**
- Consumes: Task 1 complete (no code dependency, but logically sequenced)
- Produces: the §5 determinism paragraph that Task 3's doc updates will reference

- [ ] **Step 1: Read the §5 section to find the insertion point**

Run:
```bash
grep -n "Anti-leak boundary\|---" docs/seam-contract.md | head -20
```

The insertion point is immediately after the `> **Anti-leak boundary:**` callout line and before the `---` separator that opens §6. It looks like this in the file:

```markdown
> **Anti-leak boundary:** `local.value` is `unknown` to `ns`. The payload is the question, never a hint at the answer — the engine does not tag a conflict with a suspected policy.

---

## 6. `Scope` — partition key for subscription
```

- [ ] **Step 2: Insert the determinism paragraph**

Insert the following block between the Anti-leak callout and the `---` separator:

```markdown
> **Convergence expectation (v1.0 stated requirement):** Under *local* (non-propagated) resolution — where each replica runs `Resolver.resolve()` independently — a `Resolver` MUST be a **deterministic pure function** of its `Conflict` input: given the same `(local, remote, base?, scope)`, every replica must reach the same `Resolution`. A non-deterministic local resolver diverges silently; the engine cannot detect this. Propagated resolution (gossiping the decision as a change so all replicas apply the same winner) lifts this requirement and is a Phase 3 concern. This is a constraint on resolver *implementations*, not on the `Resolver` type surface — `types.ts` is unchanged.
```

The full §5 tail should then read:

```markdown
> **Anti-leak boundary:** `local.value` is `unknown` to `ns`. The payload is the question, never a hint at the answer — the engine does not tag a conflict with a suspected policy.

> **Convergence expectation (v1.0 stated requirement):** Under *local* (non-propagated) resolution — where each replica runs `Resolver.resolve()` independently — a `Resolver` MUST be a **deterministic pure function** of its `Conflict` input: given the same `(local, remote, base?, scope)`, every replica must reach the same `Resolution`. A non-deterministic local resolver diverges silently; the engine cannot detect this. Propagated resolution (gossiping the decision as a change so all replicas apply the same winner) lifts this requirement and is a Phase 3 concern. This is a constraint on resolver *implementations*, not on the `Resolver` type surface — `types.ts` is unchanged.

---

## 6. `Scope` — partition key for subscription
```

- [ ] **Step 3: Verify no type references were accidentally added**

```bash
grep -n "ConflictUnit\|VersionedChange\|StateChange" docs/seam-contract.md | tail -5
```

The new paragraph must not introduce any new type names beyond those already in §5. (It doesn't — it only references `Resolver`, `Conflict`, `Resolution`, and `types.ts`, all already named in §5.)

- [ ] **Step 4: Run tests and typecheck (docs-only change — confirm nothing broken)**

```bash
pnpm test && pnpm exec tsc --noEmit
```

Expected: `Tests  40 passed (40)`, no tsc errors.

- [ ] **Step 5: Commit**

```bash
git add docs/seam-contract.md
git commit -m "docs(seam-contract): §5 resolver-determinism convergence expectation — v1.0 stated requirement"
```

---

### Task 3: Update implementation-state.md and decision-log.md

**Files:**
- Modify: `docs/implementation-state.md`
- Modify: `docs/decision-log.md`

**Interfaces:**
- Consumes: Tasks 1 and 2 complete (references their commit content)
- Produces: up-to-date living docs reflecting consolidation close-out

- [ ] **Step 1: Read the relevant sections of both doc files**

```bash
grep -n "P8\|P9\|Conflict\|Resolver\|determinism\|40\|debt\|carried" docs/implementation-state.md
grep -n "2026-06-28\|Phase 2\|Phase 3\|determinism" docs/decision-log.md | tail -20
```

- [ ] **Step 2: Update implementation-state.md**

Two targeted changes:

**Change A** — In the conflict/resolver seam row (the row describing `Conflict`/`Resolver`), append a note about the determinism expectation. Find the row and extend the description cell to add:

```
Convergence expectation documented in seam-contract.md §5: local resolver MUST be a deterministic pure function; propagated resolution is Phase 3.
```

**Change B** — In the Known Gaps / Carried Debt section (if any open finding references P8 or P9 as not yet landed), close those entries. The implementation-state.md already records P8/P9 as done in the engine-test row — verify it reads accurately. If it shows P8/P9 as open findings, close them.

**Change C** — Under the engine-test row or test-count summary, verify the total reads 40 (24 Phase 1b including P8/P9 + 16 Phase 2). Update only if the count is stale; if it already reads 40, leave it unchanged.

- [ ] **Step 3: Append consolidation entry to decision-log.md**

Append the following at the bottom of `docs/decision-log.md` (after the existing 2026-06-28 Phase 2 entry):

```markdown
---

### 2026-06-28 — Phase 2/3 Consolidation close-out

**P8 and P9 confirmed landed.** Both tests were written and are green (40/40). No debt remains from the Phase 1b hardening brief on the reconnect-replay and 3-replica-contention-under-partition properties.

**Resolver-determinism expectation documented.** The convergence guarantee proven in Q4 (independent replica resolution converges) holds only if the `Resolver` is a deterministic pure function of its `Conflict` input. This is now a stated requirement in `seam-contract.md` §5 at v1.0. It constrains resolver implementations, not the type surface — `types.ts` unchanged.

**`merged`/`mergeVersions` deferred to Phase 3 architect sub-gate.** The Phase 2 `throw` stays. Correct `merged` support requires `ClockStrategy.mergeVersions(a, b)` — a seam-contract addition that needs its own gate.

**`_applyOp` concurrent routing confirmed Phase 3.** The op-path concurrent arm stays deferred. The stale comment ("Phase 2 will route") was corrected to "Phase 3 will route (op path)". Op routing requires the op path to carry `VersionedChange` (not just `Version`) to build a `Conflict` payload.
```

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm test && pnpm exec tsc --noEmit
```

Expected: `Tests  40 passed (40)`, no tsc errors.

- [ ] **Step 5: Commit and push**

```bash
git add docs/implementation-state.md docs/decision-log.md
git commit -m "docs: Phase 2/3 consolidation — P8/P9 confirmed, determinism expectation recorded, Phase 3 deferrals logged"
git push
```

Expected: push succeeds to `origin/main`.
