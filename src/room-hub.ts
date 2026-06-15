import { DurableObject } from "cloudflare:workers";

import {
	builderRoomWebSocketTag,
	maxObserverRoomWebSockets,
	maxParticipantWebSockets,
	maxPublicRoomWebSockets,
	maxRoomWebSockets,
	observerRoomWebSocketTag,
	participantRoomWebSocketTag,
	publicRoomWebSocketTag,
	recordSocketMessage,
	roomWebSocketTicketHeader,
	sameOriginWebSocketRequest,
	type SocketRateState,
} from "./socket-admission.ts";

export class RoomHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS socket_tickets (
					ticket TEXT PRIMARY KEY,
					participant_id TEXT NOT NULL,
					participant_kind TEXT NOT NULL,
					expires_at INTEGER NOT NULL
				)
			`);
		});
	}

	async issueParticipantTicket(participantId: string, participantKind: string): Promise<string> {
		const now = Date.now();
		const ticket = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			"DELETE FROM socket_tickets WHERE participant_id = ? OR expires_at <= ?",
			participantId,
			now,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO socket_tickets (ticket, participant_id, participant_kind, expires_at)
			 VALUES (?, ?, ?, ?)`,
			ticket,
			participantId,
			participantKind,
			now + 30_000,
		);
		return ticket;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		if (!sameOriginWebSocketRequest(request)) {
			return new Response("same-origin websocket required", { status: 403 });
		}
		const suppliedTicket = request.headers.get(roomWebSocketTicketHeader);
		const participant = suppliedTicket ? this.consumeParticipantTicket(suppliedTicket) : null;
		if (suppliedTicket && !participant) {
			return new Response("valid websocket ticket required", { status: 401 });
		}
		const participantTag = participant ? participantRoomWebSocketTag(participant.id) : null;
		if (
			participantTag &&
			this.ctx.getWebSockets(participantTag).length >= maxParticipantWebSockets
		) {
			return new Response("participant websocket limit reached", { status: 429 });
		}
		const categoryTag = participant
			? participant.kind === "observer"
				? observerRoomWebSocketTag
				: builderRoomWebSocketTag
			: publicRoomWebSocketTag;
		const categoryLimit =
			categoryTag === publicRoomWebSocketTag
				? maxPublicRoomWebSockets
				: categoryTag === observerRoomWebSocketTag
					? maxObserverRoomWebSockets
					: null;
		if (categoryLimit !== null && this.ctx.getWebSockets(categoryTag).length >= categoryLimit) {
			return new Response("websocket category limit reached", { status: 429 });
		}
		if (this.ctx.getWebSockets().length >= maxRoomWebSockets) {
			return new Response("room websocket limit reached", { status: 429 });
		}
		const pair = new WebSocketPair();
		pair[1].serializeAttachment({
			windowStartedAt: Date.now(),
			messageCount: 0,
		} satisfies SocketRateState);
		this.ctx.acceptWebSocket(
			pair[1],
			participantTag ? [categoryTag, participantTag] : [categoryTag],
		);
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

	private consumeParticipantTicket(ticket: string): { id: string; kind: string } | null {
		const row = this.ctx.storage.sql
			.exec<{ participant_id: string; participant_kind: string; expires_at: number }>(
				`SELECT participant_id, participant_kind, expires_at
				 FROM socket_tickets WHERE ticket = ?`,
				ticket,
			)
			.toArray()[0];
		this.ctx.storage.sql.exec("DELETE FROM socket_tickets WHERE ticket = ?", ticket);
		return row && row.expires_at > Date.now()
			? { id: row.participant_id, kind: row.participant_kind }
			: null;
	}
}
