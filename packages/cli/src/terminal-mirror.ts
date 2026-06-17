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

export class TerminalMirrorHub {
	private readonly lanes = new Map<string, TerminalFanout>();
	private readonly viewers = new Map<string, Set<TerminalSubscription>>();

	publish(laneId: string, data: Uint8Array): void {
		this.lane(laneId).publish(data);
	}

	subscribe(laneId: string, viewerToken: string, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		const subscription = this.lane(laneId).subscribe(crypto.randomUUID());
		this.viewer(viewerToken).add(subscription);
		response.once("close", () => subscription.close("viewer disconnected"));
		void streamSubscription(subscription, response)
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
): Promise<void> {
	try {
		for await (const chunk of subscription) {
			if (response.destroyed || response.writableEnded) return;
			if (!response.write(chunk)) await waitForDrainOrClose(response);
		}
		if (!response.destroyed && !response.writableEnded) response.end();
	} finally {
		subscription.close("viewer stream ended");
	}
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
