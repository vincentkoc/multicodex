import { DurableObject } from "cloudflare:workers";

export class RoomHub extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
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
		if (message === "ping") socket.send("pong");
	}
}
