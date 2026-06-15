import { DurableObject } from "cloudflare:workers";

import {
	maxRoomWebSockets,
	maxRoomWebSocketsPerSource,
	recordSocketMessage,
	roomWebSocketSourceHeader,
	roomWebSocketSourceTag,
	sameOriginWebSocketRequest,
	type SocketRateState,
} from "./socket-admission.ts";

export class RoomHub extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		if (!sameOriginWebSocketRequest(request)) {
			return new Response("same-origin websocket required", { status: 403 });
		}
		const sourceTag = roomWebSocketSourceTag(request.headers.get(roomWebSocketSourceHeader));
		if (!sourceTag) return new Response("websocket admission required", { status: 403 });
		if (this.ctx.getWebSockets(sourceTag).length >= maxRoomWebSocketsPerSource) {
			return new Response("source websocket limit reached", { status: 429 });
		}
		if (this.ctx.getWebSockets().length >= maxRoomWebSockets) {
			return new Response("room websocket limit reached", { status: 429 });
		}
		const pair = new WebSocketPair();
		pair[1].serializeAttachment({
			windowStartedAt: Date.now(),
			messageCount: 0,
		} satisfies SocketRateState);
		this.ctx.acceptWebSocket(pair[1], [sourceTag]);
		pair[1].send(JSON.stringify({ type: "connected", at: Date.now() }));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	broadcast(payload: string): number {
		let delivered = 0;
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(payload);
				delivered += 1;
			} catch {
				socket.close(1011, "broadcast failed");
			}
		}
		return delivered;
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		const result = recordSocketMessage(
			socket.deserializeAttachment() as SocketRateState | null,
			Date.now(),
		);
		socket.serializeAttachment(result.state);
		if (!result.allowed) {
			socket.close(1008, "message rate exceeded");
			return;
		}
		if (message === "ping") {
			socket.send("pong");
			return;
		}
		socket.close(1003, "unsupported message");
	}
}
