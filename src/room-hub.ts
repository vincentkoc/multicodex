import { DurableObject } from "cloudflare:workers";

import {
	builderRoomWebSocketTag,
	maxObserverRoomWebSockets,
	maxParticipantWebSockets,
	maxPublicRoomWebSockets,
	maxPublicRoomWebSocketsPerSource,
	maxRoomWebSockets,
	observerRoomWebSocketTag,
	participantRoomWebSocketTag,
	publicRoomWebSocketTag,
	publicRoomWebSocketSourceTag,
	recordSocketMessage,
	roomWebSocketSourceHeader,
	roomWebSocketTicketHeader,
	sameOriginWebSocketRequest,
	type SocketRateState,
} from "./socket-admission.ts";
import { cleanupFailedLaunchRoom, reconcileRuntimeRoom } from "./runtime-cleanup.ts";
import { recordRoomCleanupAttempt } from "./store.ts";

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
		this.ctx.storage.sql.exec("DELETE FROM socket_tickets WHERE expires_at <= ?", now);
		// Preserve concurrent-tab tickets while bounding unused capabilities per participant.
		const pending = this.ctx.storage.sql
			.exec<{ ticket: string }>(
				`SELECT ticket FROM socket_tickets
				 WHERE participant_id = ?
				 ORDER BY expires_at ASC, ticket ASC`,
				participantId,
			)
			.toArray();
		for (const existing of pending.slice(
			0,
			Math.max(0, pending.length - maxParticipantWebSockets + 1),
		)) {
			this.ctx.storage.sql.exec("DELETE FROM socket_tickets WHERE ticket = ?", existing.ticket);
		}
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

	async reconcileRuntime(roomId: string): Promise<void> {
		try {
			await reconcileRuntimeRoom(this.env, roomId);
		} finally {
			try {
				await recordRoomCleanupAttempt(this.env.DB, roomId, Date.now());
			} finally {
				this.broadcast(JSON.stringify({ type: "changed", roomId, at: Date.now() }));
			}
		}
	}

	async cleanupFailedLaunch(
		roomId: string,
		expectedBriefRevision: number,
		rootSessionId: string | null,
	): Promise<void> {
		try {
			await cleanupFailedLaunchRoom(this.env, roomId, expectedBriefRevision, rootSessionId);
		} finally {
			this.broadcast(JSON.stringify({ type: "changed", roomId, at: Date.now() }));
		}
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
		const publicSourceTag = participant
			? null
			: publicRoomWebSocketSourceTag(request.headers.get(roomWebSocketSourceHeader));
		if (!participant && !publicSourceTag) {
			return new Response("public websocket admission required", { status: 403 });
		}
		if (
			publicSourceTag &&
			this.ctx.getWebSockets(publicSourceTag).length >= maxPublicRoomWebSocketsPerSource
		) {
			return new Response("public source websocket limit reached", { status: 429 });
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
			participantTag ? [categoryTag, participantTag] : [categoryTag, publicSourceTag!],
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
