import { describe, expect, expectTypeOf, test } from "vitest";
import type {
	ScopeHandle,
	SyncClient,
	SyncConfig,
	WriteOpts,
} from "../../src/client/create-sync.ts";
import { createSync } from "../../src/client/create-sync.ts";
import type {
	Change,
	Conflict,
	Lifetime,
	Resolution,
	Subscription,
	Transport,
} from "../../src/core/types.ts";
import type {
	Change as BarrelChange,
	Conflict as BarrelConflict,
	Lifetime as BarrelLifetime,
	Resolution as BarrelResolution,
	Subscription as BarrelSubscription,
	Transport as BarrelTransport,
} from "../../src/index.ts";

describe("ScopeHandle type surface", () => {
	test("set() returns void", () => {
		expectTypeOf<ScopeHandle["set"]>().returns.toBeVoid();
	});

	test("do() returns void", () => {
		expectTypeOf<ScopeHandle["do"]>().returns.toBeVoid();
	});

	test("subscribe() callback receives readonly Change[], not ChangeBatch", () => {
		type Callback = Parameters<ScopeHandle["subscribe"]>[0];
		type Arg = Parameters<Callback>[0];
		expectTypeOf<Arg>().toEqualTypeOf<readonly Change[]>();
	});

	test("subscribe() returns Subscription", () => {
		expectTypeOf<
			ScopeHandle["subscribe"]
		>().returns.toEqualTypeOf<Subscription>();
	});

	test("snapshot() returns Promise<readonly Change[]>", () => {
		expectTypeOf<ScopeHandle["snapshot"]>().returns.toEqualTypeOf<
			Promise<readonly Change[]>
		>();
	});

	test("onConflict() handler receives (Conflict, resolve fn), returns void", () => {
		type Handler = Parameters<ScopeHandle["onConflict"]>[0];
		type Arg0 = Parameters<Handler>[0];
		type Arg1 = Parameters<Handler>[1];
		expectTypeOf<Arg0>().toEqualTypeOf<Conflict>();
		expectTypeOf<Arg1>().toEqualTypeOf<(r: Resolution) => void>();
		expectTypeOf<ScopeHandle["onConflict"]>().returns.toBeVoid();
	});

	test("close() returns void", () => {
		expectTypeOf<ScopeHandle["close"]>().returns.toBeVoid();
	});
});

describe("SyncClient type surface", () => {
	test("scope() returns ScopeHandle", () => {
		expectTypeOf<SyncClient["scope"]>().returns.toEqualTypeOf<ScopeHandle>();
	});

	test("close() returns void", () => {
		expectTypeOf<SyncClient["close"]>().returns.toBeVoid();
	});
});

describe("createSync type surface", () => {
	test("createSync returns SyncClient", () => {
		expectTypeOf(createSync).returns.toEqualTypeOf<SyncClient>();
	});

	test("SyncConfig transport field is Transport", () => {
		expectTypeOf<SyncConfig["transport"]>().toEqualTypeOf<Transport>();
	});
});

describe("WriteOpts type surface", () => {
	test("lifetime is optional Lifetime", () => {
		expectTypeOf<WriteOpts["lifetime"]>().toEqualTypeOf<Lifetime | undefined>();
	});

	test("unitKey is optional string", () => {
		expectTypeOf<WriteOpts["unitKey"]>().toEqualTypeOf<string | undefined>();
	});
});

describe("barrel primitive type exports", () => {
	test("Change, Conflict, Lifetime, Resolution, Subscription, Transport are barrel-exported", () => {
		// Type-level test: if this compiles, the barrel exports these types correctly.
		// Runtime value is unused; the assertion is purely compile-time.
		const _change: BarrelChange = undefined as unknown as BarrelChange;
		const _conflict: BarrelConflict = undefined as unknown as BarrelConflict;
		const _lifetime: BarrelLifetime = { class: "durable" };
		const _resolution: BarrelResolution = { decision: "take-local" };
		const _sub: BarrelSubscription = { unsubscribe: () => {} };
		const _transport: BarrelTransport = undefined as unknown as BarrelTransport;
		expectTypeOf(_change).toMatchTypeOf<BarrelChange>();
		expectTypeOf(_conflict).toMatchTypeOf<BarrelConflict>();
		expectTypeOf(_lifetime).toMatchTypeOf<BarrelLifetime>();
		expectTypeOf(_resolution).toMatchTypeOf<BarrelResolution>();
		expectTypeOf(_sub).toMatchTypeOf<BarrelSubscription>();
		expectTypeOf(_transport).toMatchTypeOf<BarrelTransport>();
		// Verify Change and Conflict from barrel match core types
		expectTypeOf<BarrelChange>().toEqualTypeOf<Change>();
		expectTypeOf<BarrelConflict>().toEqualTypeOf<Conflict>();
		expectTypeOf<BarrelLifetime>().toEqualTypeOf<Lifetime>();
		expectTypeOf<BarrelResolution>().toEqualTypeOf<Resolution>();
		expectTypeOf<BarrelSubscription>().toEqualTypeOf<Subscription>();
		expectTypeOf<BarrelTransport>().toEqualTypeOf<Transport>();
		expect(true).toBe(true); // ensure test registers as pass
	});
});
