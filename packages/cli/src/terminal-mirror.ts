import type { ServerResponse } from "node:http";

import {
	BatchPublisher,
	TerminalFanout,
	type TerminalSubscription,
} from "@openclaw/libterminal/stream";

const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_VIEWER_BUFFER_BYTES = 1024 * 1024;
const PUBLISH_INTERVAL_MS = 40;
const PUBLISH_BATCH_BYTES = 64 * 1024;
const PROXY_FLUSH_PREAMBLE = `:${" ".repeat(4 * 1024)}\n\n`;

export class TerminalMirrorHub {
	private readonly lanes = new Map<string, TerminalFanout>();
	private readonly viewers = new Map<string, Set<TerminalSubscription>>();

	publish(laneId: string, data: Uint8Array): void {
		this.lane(laneId).publish(data);
	}

	subscribe(laneId: string, viewerToken: string, response: ServerResponse): void {
		response.writeHead(200, {
			// Browsers consume this as raw bytes, while public reverse proxies
			// recognize this type as an unbuffered streaming response.
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		// Give public tunnel proxies a valid SSE frame large enough to flush.
		response.write(PROXY_FLUSH_PREAMBLE);
		const subscription = this.lane(laneId).subscribe(crypto.randomUUID());
		this.viewer(viewerToken).add(subscription);
		response.once("close", () => subscription.close("viewer disconnected"));
		void streamSubscription(subscription, response, "terminal")
			.catch(() => response.destroy())
			.finally(() => this.removeViewerSubscription(viewerToken, subscription));
	}

	closeViewer(viewerToken: string): void {
		const subscriptions = this.viewers.get(viewerToken);
		if (!subscriptions) return;
		this.viewers.delete(viewerToken);
		for (const subscription of subscriptions) subscription.close("viewer capability revoked");
	}

	closeLane(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (!lane) return;
		lane.close("terminal mirror closed");
		this.lanes.delete(laneId);
	}

	closeAll(): void {
		for (const laneId of this.lanes.keys()) this.closeLane(laneId);
		this.viewers.clear();
	}

	private lane(laneId: string): TerminalFanout {
		let lane = this.lanes.get(laneId);
		if (!lane) {
			lane = new TerminalFanout({
				replayBytes: MAX_REPLAY_BYTES,
				subscriberBufferBytes: MAX_VIEWER_BUFFER_BYTES,
				slowSubscriberPolicy: "disconnect",
			});
			this.lanes.set(laneId, lane);
		}
		return lane;
	}

	private viewer(viewerToken: string): Set<TerminalSubscription> {
		let subscriptions = this.viewers.get(viewerToken);
		if (!subscriptions) {
			subscriptions = new Set();
			this.viewers.set(viewerToken, subscriptions);
		}
		return subscriptions;
	}

	private removeViewerSubscription(viewerToken: string, subscription: TerminalSubscription): void {
		const subscriptions = this.viewers.get(viewerToken);
		if (!subscriptions) return;
		subscriptions.delete(subscription);
		if (subscriptions.size === 0) this.viewers.delete(viewerToken);
	}
}

export class TerminalControlHub {
	private readonly lanes = new Map<string, TerminalFanout>();
	private readonly activeLanes = new Set<string>();

	publish(laneId: string, data: Uint8Array): boolean {
		const lane = this.lanes.get(laneId);
		if (!lane || lane.subscriberCount === 0) return false;
		lane.publish(data);
		return true;
	}

	subscribe(laneId: string, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		response.write(PROXY_FLUSH_PREAMBLE);
		const subscription = this.lane(laneId).subscribe(crypto.randomUUID(), { replay: false });
		response.once("close", () => subscription.close("terminal control bridge disconnected"));
		void streamSubscription(subscription, response, "input")
			.catch(() => response.destroy())
			.finally(() => this.activeLanes.delete(laneId));
	}

	markActive(laneId: string): boolean {
		if (this.activeLanes.has(laneId)) return false;
		this.activeLanes.add(laneId);
		return true;
	}

	closeLane(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (lane) lane.close("terminal control closed");
		this.lanes.delete(laneId);
		this.activeLanes.delete(laneId);
	}

	closeAll(): void {
		for (const laneId of this.lanes.keys()) this.closeLane(laneId);
		this.activeLanes.clear();
	}

	private lane(laneId: string): TerminalFanout {
		let lane = this.lanes.get(laneId);
		if (!lane) {
			lane = new TerminalFanout({
				replayBytes: 0,
				subscriberBufferBytes: 256 * 1024,
				slowSubscriberPolicy: "disconnect",
			});
			this.lanes.set(laneId, lane);
		}
		return lane;
	}
}

export class TerminalViewportHub {
	private readonly lanes = new Map<string, TerminalFanout>();

	publish(laneId: string, columns: number, rows: number): void {
		this.lane(laneId).publish(new TextEncoder().encode(JSON.stringify({ columns, rows })));
	}

	subscribe(
		laneId: string,
		response: ServerResponse,
		initialSize: { columns: number; rows: number } | null,
	): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		response.write(PROXY_FLUSH_PREAMBLE);
		if (initialSize) {
			writeSseEvent(
				response,
				"resize",
				Buffer.from(JSON.stringify(initialSize)).toString("base64"),
			);
		}
		const subscription = this.lane(laneId).subscribe(crypto.randomUUID());
		response.once("close", () => subscription.close("terminal viewport bridge disconnected"));
		void streamSubscription(subscription, response, "resize").catch(() => response.destroy());
	}

	closeLane(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (!lane) return;
		lane.close("terminal viewport closed");
		this.lanes.delete(laneId);
	}

	closeAll(): void {
		for (const laneId of this.lanes.keys()) this.closeLane(laneId);
	}

	private lane(laneId: string): TerminalFanout {
		let lane = this.lanes.get(laneId);
		if (!lane) {
			lane = new TerminalFanout({
				replayBytes: 1,
				subscriberBufferBytes: 16 * 1024,
				slowSubscriberPolicy: "disconnect",
			});
			this.lanes.set(laneId, lane);
		}
		return lane;
	}
}

export class TerminalRedrawHub {
	private readonly lanes = new Map<string, TerminalFanout>();

	publish(laneId: string): void {
		this.lane(laneId).publish(new Uint8Array([1]));
	}

	subscribe(laneId: string, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		response.write(PROXY_FLUSH_PREAMBLE);
		const subscription = this.lane(laneId).subscribe(crypto.randomUUID());
		response.once("close", () => subscription.close("terminal redraw bridge disconnected"));
		void streamSubscription(subscription, response, "redraw").catch(() => response.destroy());
	}

	closeLane(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (!lane) return;
		lane.close("terminal redraw closed");
		this.lanes.delete(laneId);
	}

	closeAll(): void {
		for (const laneId of this.lanes.keys()) this.closeLane(laneId);
	}

	private lane(laneId: string): TerminalFanout {
		let lane = this.lanes.get(laneId);
		if (!lane) {
			lane = new TerminalFanout({
				replayBytes: 1,
				subscriberBufferBytes: 16 * 1024,
				slowSubscriberPolicy: "disconnect",
			});
			this.lanes.set(laneId, lane);
		}
		return lane;
	}
}

export class TerminalMirrorPublisher {
	private readonly endpoint: URL;
	private readonly sizeEndpoint: URL;
	private readonly token: string;
	private readonly publisher: BatchPublisher;
	private stopped = false;
	private publisherStopped = false;

	constructor(server: string, laneId: string, token: string) {
		this.endpoint = new URL(`/api/lanes/${encodeURIComponent(laneId)}/terminal`, server);
		this.sizeEndpoint = new URL(`/api/lanes/${encodeURIComponent(laneId)}/terminal-size`, server);
		this.token = token;
		this.publisher = new BatchPublisher((bytes) => this.publish(bytes), {
			flushIntervalMs: PUBLISH_INTERVAL_MS,
			maxBatchBytes: PUBLISH_BATCH_BYTES,
			onError: () => undefined,
		});
	}

	write(data: string | Uint8Array): void {
		if (this.stopped) return;
		this.publisher.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
	}

	async stop(): Promise<void> {
		if (this.publisherStopped) return;
		this.stopped = true;
		this.publisherStopped = true;
		await this.publisher.stop().catch(() => undefined);
		await fetch(this.endpoint, {
			method: "DELETE",
			headers: { authorization: `Bearer ${this.token}` },
		}).catch(() => undefined);
	}

	resize(columns: number, rows: number): void {
		if (this.stopped) return;
		void fetch(this.sizeEndpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ columns, rows }),
		}).catch(() => undefined);
	}

	private async publish(bytes: Uint8Array): Promise<void> {
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/octet-stream",
			},
			body: Buffer.from(bytes),
		});
		if (response.status === 410) this.stopped = true;
	}
}

async function streamSubscription(
	subscription: TerminalSubscription,
	response: ServerResponse,
	event: "input" | "redraw" | "resize" | "terminal",
): Promise<void> {
	try {
		for await (const chunk of subscription) {
			if (response.destroyed || response.writableEnded) return;
			if (!writeSseEvent(response, event, Buffer.from(chunk).toString("base64"))) {
				await waitForDrainOrClose(response);
			}
		}
		if (!response.destroyed && !response.writableEnded) response.end();
	} finally {
		subscription.close("viewer stream ended");
	}
}

function writeSseEvent(response: ServerResponse, event: string, payload: string): boolean {
	return response.write(`event: ${event}\ndata: ${payload}\n\n`);
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			response.off("drain", done);
			response.off("close", done);
			resolve();
		};
		response.once("drain", done);
		response.once("close", done);
	});
}
