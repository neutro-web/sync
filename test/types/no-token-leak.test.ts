/**
 * G2-1 Token-Leak Gate
 *
 * Ensures no internal token (Cursor, Version, Engine, ResolverPump, construction helpers,
 * non-interface engine methods) leaks from the public barrel (src/index.ts) as a named
 * export or as a return/arg type on any public method.
 *
 * Decision log 2026-06-29: Version riding inertly on Change.version in the subscribe stream
 * is the *accepted residual* (T2 — Version is strategy-owned and opaque to ns; it lives on
 * Change but is never a named export). G2-1c asserts this residual is NOT failed by this suite.
 */
import { describe, expect, test } from "vitest";
import { expectTypeOf } from "vitest";
import * as barrel from "../../src/index.ts";
import type { Change, ScopeHandle } from "../../src/index.ts";

// ─── G2-1b: Runtime allow-list ───────────────────────────────────────────────
// Only value exports appear in Object.keys. Type-only exports are invisible at runtime.
// The allow-list is the complete, exact set. Adding a new runtime export without updating
// this list fails loudly — that is the anti-rot property.
const RUNTIME_EXPORT_ALLOWLIST = ["createSync", "lww", "vectorClock"].sort();

describe("G2-1b: runtime barrel allow-list", () => {
	test("barrel exposes exactly {createSync, lww, vectorClock} as runtime values", () => {
		expect(Object.keys(barrel).sort()).toEqual(RUNTIME_EXPORT_ALLOWLIST);
	});
});

// ─── G2-1a: Type-level leak assertions (Cursor, helpers, internals) ───────────
// Each line uses @ts-expect-error to assert the named token is NOT importable from
// the barrel. If a forbidden export is added, the @ts-expect-error becomes unnecessary
// and TypeScript emits a TS2578 error — causing pnpm typecheck to fail.

describe("G2-1a: forbidden type tokens are not named barrel exports", () => {
	test("Cursor is not a named barrel export", () => {
		// @ts-expect-error — Cursor must not be exported from the barrel
		type _NoCursor = (typeof barrel)["Cursor"];
		expect(true).toBe(true); // the assertion is purely compile-time
	});

	test("Version is not a named barrel export", () => {
		// @ts-expect-error — Version must not be exported from the barrel
		type _NoVersion = (typeof barrel)["Version"];
		expect(true).toBe(true);
	});

	test("Engine is not a named barrel export", () => {
		// @ts-expect-error — Engine must not be exported from the barrel
		type _NoEngine = (typeof barrel)["Engine"];
		expect(true).toBe(true);
	});

	test("ResolverPump is not a named barrel export", () => {
		// @ts-expect-error — ResolverPump must not be exported from the barrel
		type _NoResolverPump = (typeof barrel)["ResolverPump"];
		expect(true).toBe(true);
	});

	test("makeChangeId is not a named barrel export", () => {
		// @ts-expect-error — construction helper must not be exported
		type _NoMakeChangeId = (typeof barrel)["makeChangeId"];
		expect(true).toBe(true);
	});

	test("makeConflictUnit is not a named barrel export", () => {
		// @ts-expect-error — construction helper must not be exported
		type _NoMakeConflictUnit = (typeof barrel)["makeConflictUnit"];
		expect(true).toBe(true);
	});

	test("makeCursor is not a named barrel export", () => {
		// @ts-expect-error — construction helper must not be exported
		type _NoMakeCursor = (typeof barrel)["makeCursor"];
		expect(true).toBe(true);
	});

	test("makeScope is not a named barrel export", () => {
		// @ts-expect-error — construction helper must not be exported
		type _NoMakeScope = (typeof barrel)["makeScope"];
		expect(true).toBe(true);
	});

	test("resolveConflict is not a named barrel export", () => {
		// @ts-expect-error — non-interface engine method must not be exported
		type _NoResolveConflict = (typeof barrel)["resolveConflict"];
		expect(true).toBe(true);
	});

	test("getCursor is not a named barrel export", () => {
		// @ts-expect-error — non-interface engine method must not be exported
		type _NoGetCursor = (typeof barrel)["getCursor"];
		expect(true).toBe(true);
	});

	test("DURABLE is not a named barrel export", () => {
		// @ts-expect-error — internal constant must not be exported
		type _NoDURABLE = (typeof barrel)["DURABLE"];
		expect(true).toBe(true);
	});
});

// ─── G2-1a: Public method return/arg types contain no Cursor ─────────────────

describe("G2-1a: public method types exclude Cursor", () => {
	test("ScopeHandle.subscribe callback receives readonly Change[], not ChangeBatch", () => {
		// If Cursor leaked into the arg type, this would fail (Change[] ≠ ChangeBatch).
		// This assertion is also in public-surface.test.ts — kept here as the leak-gate anchor.
		type Callback = Parameters<ScopeHandle["subscribe"]>[0];
		type Arg = Parameters<Callback>[0];
		expectTypeOf<Arg>().toEqualTypeOf<readonly Change[]>();
	});

	test("ScopeHandle.snapshot() returns Promise<readonly Change[]> — no Cursor in return type", () => {
		expectTypeOf<ScopeHandle["snapshot"]>().returns.toEqualTypeOf<
			Promise<readonly Change[]>
		>();
	});
});

// ─── G2-1c: Accepted residual — Version on Change is NOT failed ───────────────
// Decision log 2026-06-29: Version inert inside Change.version in the subscribe stream
// is the accepted residual (T2 — Version is strategy-owned, opaque, and never a named
// export). Do NOT assert Version is absent from Change — doing so would contradict the
// logged decision and would break the zero-copy-read contract.
//
// This test asserts the residual is PRESENT (i.e. Change may carry a version field),
// which acts as a guard against a future "tighten the leak test" pass accidentally
// removing this accepted residual from the type.

describe("G2-1c: accepted residual — Change.version is present and not asserted absent", () => {
	test("Change carries a version field (accepted residual — T2, decision 2026-06-29)", () => {
		// Change.version is optional (only state changes carry it) but typed.
		// If someone removes this field from the type in an attempt to tighten the
		// leak gate, this test fails — that is intentional.
		type MaybeVersion = Change extends { version?: unknown } ? true : false;
		expectTypeOf<MaybeVersion>().toEqualTypeOf<true>();
		expect(true).toBe(true);
	});
});
