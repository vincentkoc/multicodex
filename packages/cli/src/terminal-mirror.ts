import type { ServerResponse } from "node:http";

const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_VIEWER_BUFFER_BYTES = 1024 * 1024;
const PUBLISH_INTERVAL_MS = 40;
const PUBLISH_BATCH_BYTES = 64 * 1024;

type TerminalLane = {
	replay: Buffer[];
	replayBytes: number;
	viewers: Set<ServerResponse>;
};

export class TerminalMirrorHub {
	private readonly lanes = new Map<string, TerminalLane>();

	publish(laneId: string, data: Uint8Array): void {
		if (!data.byteLength) return;
		const lane = this.lanes.get(laneId) ?? {
			replay: [],
			replayBytes: 0,
			viewers: new Set<ServerResponse>(),
		};
		this.lanes.set(laneId, lane);
		const chunk = Buffer.from(data);
		const replayChunk =
			chunk.byteLength > MAX_REPLAY_BYTES ? chunk.subarray(-MAX_REPLAY_BYTES) : chunk;
		lane.replay.push(replayChunk);
		lane.replayBytes += replayChunk.byteLength;
		while (lane.replayBytes > MAX_REPLAY_BYTES && lane.replay.length > 1) {
			lane.replayBytes -= lane.replay.shift()!.byteLength;
		}
		for (const viewer of lane.viewers) {
			if (viewer.destroyed || viewer.writableEnded) {
				lane.viewers.delete(viewer);
				continue;
			}
			if (viewer.writableLength > MAX_VIEWER_BUFFER_BYTES) {
				viewer.destroy();
				lane.viewers.delete(viewer);
				continue;
			}
			viewer.write(chunk);
		}
	}

	subscribe(laneId: string, response: ServerResponse): void {
		const lane = this.lanes.get(laneId) ?? {
			replay: [],
			replayBytes: 0,
			viewers: new Set<ServerResponse>(),
		};
		this.lanes.set(laneId, lane);
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-accel-buffering": "no",
		});
		response.flushHeaders();
		for (const chunk of lane.replay) response.write(chunk);
		lane.viewers.add(response);
		response.once("close", () => lane.viewers.delete(response));
	}

	closeLane(laneId: string): void {
		const lane = this.lanes.get(laneId);
		if (!lane) return;
		for (const viewer of lane.viewers) viewer.end();
		this.lanes.delete(laneId);
	}

	closeAll(): void {
		for (const laneId of this.lanes.keys()) this.closeLane(laneId);
	}
}

export class TerminalMirrorPublisher {
	private readonly endpoint: URL;
	private readonly sizeEndpoint: URL;
	private readonly token: string;
	private chunks: Buffer[] = [];
	private bytes = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(server: string, laneId: string, token: string) {
		this.endpoint = new URL(`/api/lanes/${encodeURIComponent(laneId)}/terminal`, server);
		this.sizeEndpoint = new URL(`/api/lanes/${encodeURIComponent(laneId)}/terminal-size`, server);
		this.token = token;
	}

	write(data: string | Uint8Array): void {
		if (this.stopped) return;
		const chunk = Buffer.from(data);
		if (!chunk.byteLength) return;
		this.chunks.push(chunk);
		this.bytes += chunk.byteLength;
		if (this.bytes >= PUBLISH_BATCH_BYTES) void this.flush();
		else if (!this.timer) this.timer = setTimeout(() => void this.flush(), PUBLISH_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		await this.flush();
		await this.pending;
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

	private async flush(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (!this.chunks.length) return;
		const body = Buffer.concat(this.chunks);
		this.chunks = [];
		this.bytes = 0;
		this.pending = this.pending
			.catch(() => undefined)
			.then(async () => {
				const response = await fetch(this.endpoint, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.token}`,
						"content-type": "application/octet-stream",
					},
					body,
				});
				if (response.status === 410) this.stopped = true;
				if (!response.ok && response.status !== 410) {
					throw new Error(`terminal mirror publish failed (${response.status})`);
				}
			})
			.catch(() => undefined);
		await this.pending;
	}
}
