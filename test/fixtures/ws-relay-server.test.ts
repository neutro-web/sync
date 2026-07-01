import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRelay } from "./ws-relay-server.ts";

describe("ws-relay-server fixture", () => {
	it("fans out one peer's message to all other connected peers, not back to itself", async () => {
		const relay = await startRelay();
		const a = new WebSocket(`ws://localhost:${relay.port}`);
		const b = new WebSocket(`ws://localhost:${relay.port}`);
		await Promise.all([
			new Promise((r) => a.once("open", r)),
			new Promise((r) => b.once("open", r)),
		]);

		const bMessages: string[] = [];
		const aMessages: string[] = [];
		b.on("message", (data) => bMessages.push(data.toString()));
		a.on("message", (data) => aMessages.push(data.toString()));

		a.send("hello-from-a");
		await new Promise((r) => setTimeout(r, 50));

		expect(bMessages).toEqual(["hello-from-a"]);
		expect(aMessages).toEqual([]); // relay does not echo back to sender

		a.close();
		b.close();
		await relay.close();
	});
});
