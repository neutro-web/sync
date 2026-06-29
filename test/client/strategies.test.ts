import { describe, expect, test } from "vitest";
import { lww, vectorClock } from "../../src/strategies/index.ts";

describe("lww()", () => {
	test("returns a ClockStrategy that never returns concurrent", () => {
		const s = lww();
		const v1 = s.mint();
		const v2 = s.mint(v1);
		expect(s.compare(v1, v2)).not.toBe("concurrent");
		expect(s.compare(v2, v1)).not.toBe("concurrent");
	});

	test("two instances with explicit nodeIds break ties deterministically", () => {
		const sLow = lww(0);
		const sHigh = lww(1);
		// Both mint at ts=1; higher node wins
		const vLow = sLow.mint();
		const vHigh = sHigh.mint();
		expect(sLow.compare(vHigh, vLow)).toBe("after");
		expect(sLow.compare(vLow, vHigh)).toBe("before");
	});

	test("successive calls without args produce unique instances", () => {
		const a = lww();
		const b = lww();
		const va = a.mint();
		const vb = b.mint();
		// Different instances — same ts, different nodes — still total order
		expect(a.compare(va, vb)).not.toBe("concurrent");
	});
});

describe("vectorClock()", () => {
	test("returns a ClockStrategy that can return concurrent", () => {
		const a = vectorClock("node-a");
		const b = vectorClock("node-b");
		// Independent mints with no shared causal history are concurrent
		const va = a.mint();
		const vb = b.mint();
		expect(a.compare(va, vb)).toBe("concurrent");
	});

	test("after minting with prev, the result is causally after prev", () => {
		const s = vectorClock("n1");
		const v1 = s.mint();
		const v2 = s.mint(v1);
		expect(s.compare(v2, v1)).toBe("after");
		expect(s.compare(v1, v2)).toBe("before");
	});

	test("auto-generated nodeId produces unique strategies", () => {
		const a = vectorClock();
		const b = vectorClock();
		const va = a.mint();
		const vb = b.mint();
		// Different auto-node ids → concurrent independent writes
		expect(a.compare(va, vb)).toBe("concurrent");
	});

	test("supports mergeVersions", () => {
		const s1 = vectorClock("n1");
		const s2 = vectorClock("n2");
		const va = s1.mint();
		const vb = s2.mint();
		// biome-ignore lint/style/noNonNullAssertion: mergeVersions is defined on VectorClockStrategy
		const merged = s1.mergeVersions!(va, vb);
		expect(s1.compare(merged, va)).toBe("after");
		expect(s1.compare(merged, vb)).toBe("after");
	});
});
