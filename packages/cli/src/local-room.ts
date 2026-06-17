import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
	type AlphaLane,
	type AlphaRoomSnapshot,
	type ConductorMessage,
	type LaneCommand,
	type LaneCommandKind,
	type LaneEvent,
	type LanePolicy,
	type RoomInvite,
	policyAllows,
	protocolVersion,
	requiredPolicyForCommand,
} from "../../protocol/src/index.ts";
import { readTerminalAsset } from "./terminal-assets.ts";
import { TerminalMirrorHub } from "./terminal-mirror.ts";
import { localRoomHtml } from "./ui.ts";

type StoredLane = AlphaLane & { token: string };
type StoredInvite = RoomInvite & { token: string };

type StoredRoom = Omit<AlphaRoomSnapshot, "invites" | "lanes"> & {
	invites: StoredInvite[];
	lanes: StoredLane[];
	commands: LaneCommand[];
	eventIds: string[];
	hostToken: string;
	inviteToken: string;
};

export class LocalRoomStore {
	private readonly statePath: string;
	private readonly state: StoredRoom;
	private savePromise: Promise<void> = Promise.resolve();

	private constructor(statePath: string, state: StoredRoom) {
		this.statePath = statePath;
		this.state = state;
	}

	static async create(input: {
		stateDir: string;
		title: string;
		repo: string;
	}): Promise<LocalRoomStore> {
		await fs.mkdir(input.stateDir, { recursive: true, mode: 0o700 });
		const statePath = path.join(input.stateDir, "room.json");
		const state: StoredRoom = {
			version: protocolVersion,
			id: `room_${crypto.randomUUID()}`,
			title: input.title,
			repo: input.repo,
			createdAt: Date.now(),
			invites: [],
			lanes: [],
			events: [],
			conductorMessages: [],
			commands: [],
			eventIds: [],
			hostToken: crypto.randomUUID(),
			inviteToken: crypto.randomUUID(),
		};
		const store = new LocalRoomStore(statePath, state);
		await store.save();
		return store;
	}

	static async load(stateDir: string): Promise<LocalRoomStore> {
		const statePath = path.join(stateDir, "room.json");
		const state = JSON.parse(await fs.readFile(statePath, "utf8")) as StoredRoom;
		state.hostToken ||= crypto.randomUUID();
		state.inviteToken ||= crypto.randomUUID();
		state.invites ??= [];
		for (const lane of state.lanes) {
			lane.removedAt ??= null;
			lane.terminalMirror ??= false;
			lane.terminalColumns ??= null;
			lane.terminalRows ??= null;
		}
		const store = new LocalRoomStore(statePath, state);
		await store.save();
		return store;
	}

	snapshot(): AlphaRoomSnapshot {
		return {
			version: this.state.version,
			id: this.state.id,
			title: this.state.title,
			repo: publicRepoName(this.state.repo),
			createdAt: this.state.createdAt,
			invites: this.state.invites.map(({ token: _token, ...invite }) => invite),
			lanes: this.state.lanes.map(({ token: _token, ...lane }) => ({
				...lane,
				repo: publicRepoName(lane.repo),
			})),
			events: this.state.events.slice(-300),
			conductorMessages: this.state.conductorMessages.slice(-100),
		};
	}

	hostConfig(publicUrl: string): {
		inviteUrl: string;
		joinCommand: string;
		activeLanes: number;
		invites: Array<{ id: string; joinCommand: string }>;
	} {
		const inviteUrl = capabilityUrl(publicUrl, "invite", this.state.inviteToken);
		return {
			inviteUrl,
			joinCommand: joinCommand(inviteUrl),
			activeLanes: this.state.lanes.filter((lane) => !lane.removedAt).length,
			invites: this.state.invites
				.filter((invite) => !invite.claimedAt && !invite.revokedAt)
				.map((invite) => ({
					id: invite.id,
					joinCommand: joinCommand(capabilityUrl(publicUrl, "invite", invite.token), invite),
				})),
		};
	}

	hostUrl(publicUrl: string): string {
		return capabilityUrl(publicUrl, "host", this.state.hostToken);
	}

	inviteUrl(publicUrl: string): string {
		return capabilityUrl(publicUrl, "invite", this.state.inviteToken);
	}

	authorizeHost(token: string): boolean {
		return token === this.state.hostToken;
	}

	authorizeInvite(token: string): boolean {
		return token === this.state.inviteToken;
	}

	async createInvite(input: {
		displayName: string;
		policy: LanePolicy;
		terminalMirror?: boolean;
	}): Promise<{ invite: RoomInvite; token: string }> {
		const invite: StoredInvite = {
			id: `invite_${crypto.randomUUID()}`,
			token: crypto.randomUUID(),
			displayName: input.displayName,
			policy: input.policy,
			terminalMirror: input.terminalMirror !== false,
			createdAt: Date.now(),
			claimedAt: null,
			claimedLaneId: null,
			revokedAt: null,
		};
		this.state.invites.push(invite);
		await this.save();
		const { token, ...publicInvite } = invite;
		return { invite: publicInvite, token };
	}

	async revokeInvite(inviteId: string): Promise<void> {
		const invite = this.state.invites.find((candidate) => candidate.id === inviteId);
		if (!invite) throw new RoomError(404, "invite not found");
		if (invite.claimedAt) throw new RoomError(409, "invite already claimed");
		if (invite.revokedAt) return;
		invite.revokedAt = Date.now();
		await this.save();
	}

	async joinFromInvite(
		inviteToken: string,
		input: {
			displayName: string;
			repo: string;
			policy: LanePolicy;
			terminalMirror?: boolean;
		},
	): Promise<{ lane: AlphaLane; token: string }> {
		if (this.authorizeInvite(inviteToken)) return this.join(input);
		const invite = this.state.invites.find((candidate) => candidate.token === inviteToken);
		if (!invite) throw new RoomError(401, "valid room invite required");
		if (invite.revokedAt) throw new RoomError(410, "invite revoked by host");
		if (invite.claimedAt) throw new RoomError(410, "invite already claimed");
		invite.claimedAt = Date.now();
		await this.save();
		try {
			const joined = await this.join({
				displayName: invite.displayName,
				repo: input.repo,
				policy: invite.policy,
				terminalMirror: invite.terminalMirror,
			});
			invite.claimedLaneId = joined.lane.id;
			await this.save();
			return joined;
		} catch (cause) {
			invite.claimedAt = null;
			await this.save();
			throw cause;
		}
	}

	async join(input: {
		displayName: string;
		repo: string;
		policy: LanePolicy;
		terminalMirror?: boolean;
	}): Promise<{ lane: AlphaLane; token: string }> {
		const now = Date.now();
		const lane: StoredLane = {
			id: `lane_${crypto.randomUUID()}`,
			token: crypto.randomUUID(),
			displayName: input.displayName,
			repo: input.repo,
			policy: input.policy,
			terminalMirror: Boolean(input.terminalMirror),
			terminalColumns: null,
			terminalRows: null,
			connected: false,
			threadId: null,
			currentTurnId: null,
			lastEventSequence: 0,
			lastCommandSequence: 0,
			status: "joining",
			joinedAt: now,
			updatedAt: now,
			removedAt: null,
		};
		this.state.lanes.push(lane);
		await this.save();
		const { token, ...publicLane } = lane;
		return { lane: publicLane, token };
	}

	async resumeLane(
		laneId: string,
		token: string,
		input: {
			displayName: string;
			repo: string;
			policy: LanePolicy;
			terminalMirror?: boolean;
		},
	): Promise<{ lane: AlphaLane }> {
		const lane = this.state.lanes.find(
			(candidate) => candidate.id === laneId && candidate.token === token,
		);
		if (!lane) throw new RoomError(401, "valid lane capability required");
		if (lane.removedAt) throw new RoomError(410, "lane removed by host");
		lane.displayName = input.displayName;
		lane.repo = input.repo;
		lane.policy = input.policy;
		lane.terminalMirror = Boolean(input.terminalMirror);
		lane.updatedAt = Date.now();
		lane.status = "reconnecting";
		await this.save();
		const { token: _token, ...publicLane } = lane;
		return { lane: publicLane };
	}

	authorizeLane(laneId: string, token: string): StoredLane | null {
		return (
			this.state.lanes.find(
				(lane) => lane.id === laneId && lane.token === token && !lane.removedAt,
			) ?? null
		);
	}

	authorizeParticipant(token: string): boolean {
		return this.state.lanes.some((lane) => lane.token === token && !lane.removedAt);
	}

	authorizeTerminalViewer(laneId: string, token: string): boolean {
		const lane = this.state.lanes.find((candidate) => candidate.id === laneId);
		if (!lane || lane.removedAt || !lane.terminalMirror) return false;
		return token === this.state.hostToken || this.authorizeParticipant(token);
	}

	authorizeTerminalPublisher(laneId: string, token: string): boolean {
		const lane = this.authorizeLane(laneId, token);
		return Boolean(lane?.terminalMirror);
	}

	async updateTerminalSize(
		laneId: string,
		token: string,
		columns: number,
		rows: number,
	): Promise<void> {
		const lane = this.requireLane(laneId, token);
		if (!lane.terminalMirror) throw new RoomError(403, "terminal mirror unavailable");
		lane.terminalColumns = terminalDimension(columns, 20, 400);
		lane.terminalRows = terminalDimension(rows, 10, 200);
		lane.updatedAt = Date.now();
		await this.save();
	}

	async appendEvents(laneId: string, token: string, events: LaneEvent[]): Promise<number> {
		const lane = this.requireLane(laneId, token);
		for (const event of events) {
			if (
				event.version !== protocolVersion ||
				event.roomId !== this.state.id ||
				event.laneId !== lane.id
			) {
				throw new RoomError(400, "invalid lane event envelope");
			}
			if (this.state.eventIds.includes(event.id) || event.sequence <= lane.lastEventSequence)
				continue;
			if (event.sequence !== lane.lastEventSequence + 1) {
				throw new RoomError(409, `event gap: expected ${lane.lastEventSequence + 1}`);
			}
			this.state.events.push(event);
			this.state.eventIds.push(event.id);
			lane.lastEventSequence = event.sequence;
			lane.updatedAt = event.at;
			applyLaneEvent(lane, event);
		}
		this.state.events.splice(0, Math.max(0, this.state.events.length - 1_000));
		this.state.eventIds.splice(0, Math.max(0, this.state.eventIds.length - 2_000));
		await this.save();
		return lane.lastEventSequence;
	}

	commandsAfter(laneId: string, token: string, after: number): LaneCommand[] {
		this.requireLane(laneId, token);
		return this.state.commands.filter(
			(command) => command.laneId === laneId && command.sequence > after,
		);
	}

	async queueCommand(laneId: string, kind: LaneCommandKind, text: string): Promise<LaneCommand> {
		const lane = this.state.lanes.find((candidate) => candidate.id === laneId);
		if (!lane) throw new RoomError(404, "lane not found");
		if (lane.removedAt) throw new RoomError(410, "lane removed by host");
		if (!policyAllows(lane.policy, kind)) {
			throw new RoomError(409, `${kind} requires ${requiredPolicyForCommand(kind)} policy`);
		}
		const now = Date.now();
		const command: LaneCommand = {
			version: protocolVersion,
			id: `command_${crypto.randomUUID()}`,
			roomId: this.state.id,
			laneId,
			sequence: lane.lastCommandSequence + 1,
			at: now,
			expiresAt: now + 5 * 60_000,
			kind,
			text,
			source: "conductor",
			requiredPolicy: requiredPolicyForCommand(kind),
		};
		lane.lastCommandSequence = command.sequence;
		lane.updatedAt = now;
		this.state.commands.push(command);
		this.state.commands.splice(0, Math.max(0, this.state.commands.length - 500));
		await this.save();
		return command;
	}

	async removeLane(laneId: string): Promise<void> {
		const lane = this.state.lanes.find((candidate) => candidate.id === laneId);
		if (!lane) throw new RoomError(404, "lane not found");
		if (lane.removedAt) return;
		const now = Date.now();
		lane.removedAt = now;
		lane.connected = false;
		lane.currentTurnId = null;
		lane.status = "removed by host";
		lane.updatedAt = now;
		await this.addConductorMessage("system", `${lane.displayName} removed by host`);
	}

	async addParticipantMessage(laneId: string, token: string, body: string): Promise<string> {
		const lane = this.requireLane(laneId, token);
		await this.addConductorMessage("participant", body, {
			authorName: lane.displayName,
			laneId: lane.id,
		});
		return lane.displayName;
	}

	async addConductorMessage(
		author: ConductorMessage["author"],
		body: string,
		detail?: Pick<ConductorMessage, "authorName" | "laneId">,
	): Promise<void> {
		const previous = this.state.conductorMessages.at(-1);
		if (
			previous?.author === author &&
			previous.body === body &&
			previous.authorName === detail?.authorName &&
			previous.laneId === detail?.laneId
		) {
			return;
		}
		this.state.conductorMessages.push({
			id: `message_${crypto.randomUUID()}`,
			author,
			...detail,
			body,
			at: Date.now(),
		});
		this.state.conductorMessages.splice(0, Math.max(0, this.state.conductorMessages.length - 300));
		await this.save();
	}

	private requireLane(laneId: string, token: string): StoredLane {
		const lane = this.state.lanes.find((candidate) => candidate.id === laneId);
		if (!lane || lane.token !== token) throw new RoomError(401, "valid lane capability required");
		if (lane.removedAt) throw new RoomError(410, "lane removed by host");
		return lane;
	}

	private async save(): Promise<void> {
		this.savePromise = this.savePromise.then(async () => {
			const temporary = `${this.statePath}.tmp`;
			await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(temporary, this.statePath);
		});
		await this.savePromise;
	}
}

export type LocalRoomHandlers = {
	onConductorMessage: (text: string) => Promise<void>;
	onConductorCommand: (laneId: string, kind: LaneCommandKind, text: string) => Promise<void>;
};

export async function startLocalRoomServer(input: {
	store: LocalRoomStore;
	port: number;
	host?: string;
	publicUrl?: string;
	handlers: LocalRoomHandlers;
}): Promise<{
	url: string;
	hostUrl: string;
	inviteUrl: string;
	close: () => Promise<void>;
}> {
	const host = input.host ?? "127.0.0.1";
	if (["0.0.0.0", "::"].includes(host) && !input.publicUrl) {
		throw new RoomError(400, "--public-url is required when binding to all interfaces");
	}
	if (input.publicUrl) new URL(input.publicUrl);
	let publicUrl = "";
	const terminalHub = new TerminalMirrorHub();
	const server = http.createServer((request, response) => {
		void handleRequest(
			input.store,
			input.handlers,
			terminalHub,
			publicUrl,
			request,
			response,
		).catch((cause) => {
			const error = cause instanceof RoomError ? cause : new RoomError(500, errorMessage(cause));
			if (!response.headersSent) sendJson(response, error.status, { error: error.message });
			else response.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(input.port, host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : input.port;
	publicUrl = advertisedUrl(host, port, input.publicUrl);
	return {
		url: publicUrl,
		hostUrl: input.store.hostUrl(publicUrl),
		inviteUrl: input.store.inviteUrl(publicUrl),
		close: async () => {
			terminalHub.closeAll();
			await new Promise<void>((resolve, reject) =>
				server.close((cause) => (cause ? reject(cause) : resolve())),
			);
		},
	};
}

async function handleRequest(
	store: LocalRoomStore,
	handlers: LocalRoomHandlers,
	terminalHub: TerminalMirrorHub,
	publicUrl: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/") {
		sendText(response, 200, localRoomHtml(), "text/html; charset=utf-8");
		return;
	}
	if (request.method === "GET") {
		const asset = await readTerminalAsset(url.pathname);
		if (asset) {
			sendBinary(response, 200, asset.body, asset.contentType);
			return;
		}
	}
	if (request.method === "GET" && url.pathname === "/api/snapshot") {
		sendJson(response, 200, store.snapshot());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/host/config") {
		requireHost(store, request);
		sendJson(response, 200, store.hostConfig(publicUrl));
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/invites") {
		requireHost(store, request);
		const body = await readJson(request);
		const policy = requiredPolicy(body.policy);
		const created = await store.createInvite({
			displayName: requiredString(body.displayName, "displayName"),
			policy,
			terminalMirror: body.terminalMirror !== false,
		});
		const inviteUrl = capabilityUrl(publicUrl, "invite", created.token);
		sendJson(response, 201, {
			invite: created.invite,
			inviteUrl,
			joinCommand: joinCommand(inviteUrl, created.invite),
		});
		return;
	}
	const inviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
	if (request.method === "DELETE" && inviteMatch) {
		requireHost(store, request);
		await store.revokeInvite(decodeURIComponent(inviteMatch[1]!));
		sendJson(response, 200, { revoked: true });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/join") {
		const body = await readJson(request);
		const joined = await store.joinFromInvite(bearer(request), {
			displayName: requiredString(body.displayName, "displayName"),
			repo: requiredString(body.repo, "repo"),
			policy: requiredPolicy(body.policy),
			terminalMirror: body.terminalMirror === true,
		});
		sendJson(response, 201, { room: store.snapshot(), ...joined });
		return;
	}
	const resumeMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/resume$/);
	if (request.method === "POST" && resumeMatch) {
		const body = await readJson(request);
		const laneId = decodeURIComponent(resumeMatch[1]!);
		const terminalMirror = body.terminalMirror === true;
		const resumed = await store.resumeLane(laneId, bearer(request), {
			displayName: requiredString(body.displayName, "displayName"),
			repo: requiredString(body.repo, "repo"),
			policy: requiredPolicy(body.policy),
			terminalMirror,
		});
		if (!terminalMirror) terminalHub.closeLane(laneId);
		sendJson(response, 200, { room: store.snapshot(), ...resumed });
		return;
	}
	const eventMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/events$/);
	if (request.method === "POST" && eventMatch) {
		const laneId = decodeURIComponent(eventMatch[1]!);
		const body = await readJson(request);
		const events = Array.isArray(body.events) ? (body.events as LaneEvent[]) : [];
		const ackSequence = await store.appendEvents(laneId, bearer(request), events);
		sendJson(response, 200, { ackSequence });
		return;
	}
	const commandMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/commands$/);
	if (request.method === "GET" && commandMatch) {
		const laneId = decodeURIComponent(commandMatch[1]!);
		const after = Number(url.searchParams.get("after") ?? "0");
		sendJson(response, 200, { commands: store.commandsAfter(laneId, bearer(request), after) });
		return;
	}
	const terminalMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/terminal$/);
	if (terminalMatch) {
		const laneId = decodeURIComponent(terminalMatch[1]!);
		const token = optionalBearer(request);
		if (request.method === "GET") {
			if (!store.authorizeTerminalViewer(laneId, token)) {
				throw new RoomError(403, "terminal mirror unavailable");
			}
			terminalHub.subscribe(laneId, response);
			return;
		}
		if (request.method === "POST") {
			if (!store.authorizeTerminalPublisher(laneId, token)) {
				throw new RoomError(403, "terminal mirror unavailable");
			}
			for await (const chunk of request) terminalHub.publish(laneId, Buffer.from(chunk));
			sendJson(response, 202, { accepted: true });
			return;
		}
	}
	const terminalSizeMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/terminal-size$/);
	if (request.method === "POST" && terminalSizeMatch) {
		const body = await readJson(request);
		await store.updateTerminalSize(
			decodeURIComponent(terminalSizeMatch[1]!),
			bearer(request),
			Number(body.columns),
			Number(body.rows),
		);
		sendJson(response, 202, { accepted: true });
		return;
	}
	const laneMessageMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/message$/);
	if (request.method === "POST" && laneMessageMatch) {
		const laneId = decodeURIComponent(laneMessageMatch[1]!);
		const body = await readJson(request);
		const text = requiredString(body.text, "text");
		const displayName = await store.addParticipantMessage(laneId, bearer(request), text);
		void handlers
			.onConductorMessage(`${displayName}: ${text}`)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/conductor/message") {
		requireHost(store, request);
		const body = await readJson(request);
		const text = requiredString(body.text, "text");
		await store.addConductorMessage("host", text);
		void handlers
			.onConductorMessage(text)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	const removeMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)$/);
	if (request.method === "DELETE" && removeMatch) {
		requireHost(store, request);
		const laneId = decodeURIComponent(removeMatch[1]!);
		await store.removeLane(laneId);
		terminalHub.closeLane(laneId);
		sendJson(response, 200, { removed: true });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/conductor/command") {
		requireHost(store, request);
		const body = await readJson(request);
		const laneId = requiredString(body.laneId, "laneId");
		const kind = requiredCommandKind(body.kind);
		const text = requiredString(body.text, "text");
		void handlers
			.onConductorCommand(laneId, kind, text)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor command failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/conductor/steer") {
		requireHost(store, request);
		const body = await readJson(request);
		const laneId = requiredString(body.laneId, "laneId");
		const text = requiredString(body.text, "text");
		await store.addConductorMessage("host", `requested steer -> ${laneId}: ${text}`);
		void handlers
			.onConductorCommand(laneId, "steer_active_turn", text)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor steer failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	throw new RoomError(404, "not found");
}

function applyLaneEvent(lane: StoredLane, event: LaneEvent): void {
	lane.status = event.summary;
	if (event.kind === "lane.connected") lane.connected = true;
	if (event.kind === "lane.disconnected") lane.connected = false;
	if (event.kind === "lane.thread_attached") lane.threadId = stringPayload(event, "threadId");
	if (event.kind === "turn.started") lane.currentTurnId = stringPayload(event, "turnId");
	if (["turn.completed", "turn.failed"].includes(event.kind)) lane.currentTurnId = null;
}

function stringPayload(event: LaneEvent, key: string): string | null {
	const value = event.payload?.[key];
	return typeof value === "string" ? value : null;
}

function publicRepoName(repo: string): string {
	return path.basename(path.resolve(repo)) || "<repo>";
}

class RoomError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > 256_000) throw new RoomError(413, "request too large");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
	} catch {
		throw new RoomError(400, "valid JSON required");
	}
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new RoomError(400, `${name} is required`);
	return value.trim();
}

function bearer(request: IncomingMessage): string {
	const value = request.headers.authorization;
	if (!value?.startsWith("Bearer ")) throw new RoomError(401, "lane capability required");
	return value.slice("Bearer ".length);
}

function optionalBearer(request: IncomingMessage): string {
	const value = request.headers.authorization;
	return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function requireHost(store: LocalRoomStore, request: IncomingMessage): void {
	if (!store.authorizeHost(bearer(request))) throw new RoomError(401, "host capability required");
}

function requiredCommandKind(value: unknown): LaneCommandKind {
	if (
		![
			"suggest",
			"start_followup",
			"steer_active_turn",
			"request_status",
			"request_interrupt",
		].includes(String(value))
	) {
		throw new RoomError(400, "valid command kind required");
	}
	return value as LaneCommandKind;
}

function requiredPolicy(value: unknown): LanePolicy {
	if (!["observe", "suggest", "steer"].includes(String(value))) {
		throw new RoomError(400, "policy must be observe, suggest, or steer");
	}
	return value as LanePolicy;
}

function terminalDimension(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) throw new RoomError(400, "valid terminal dimensions required");
	return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function advertisedUrl(host: string, port: number, configured?: string): string {
	if (configured) return new URL(configured).toString().replace(/\/$/, "");
	if (["0.0.0.0", "::"].includes(host)) {
		throw new RoomError(400, "--public-url is required when binding to all interfaces");
	}
	const displayHost = host.includes(":") ? `[${host}]` : host;
	return `http://${displayHost}:${port}`;
}

function capabilityUrl(base: string, kind: "host" | "invite", token: string): string {
	const url = new URL(base);
	url.hash = new URLSearchParams({ [kind]: token }).toString();
	return url.toString();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function joinCommand(
	inviteUrl: string,
	invite?: Pick<RoomInvite, "displayName" | "policy" | "terminalMirror">,
): string {
	const command = `npx --yes @vincentkoc/multicodex@latest join ${shellQuote(inviteUrl)} --repo .`;
	if (!invite) return `${command} --terminal-mirror`;
	return `${command} --name ${shellQuote(invite.displayName)} --policy ${invite.policy}${invite.terminalMirror ? " --terminal-mirror" : ""}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	sendText(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendBinary(
	response: ServerResponse,
	status: number,
	body: Uint8Array,
	contentType: string,
): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": String(body.byteLength),
		"cache-control": "public, max-age=31536000, immutable",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function sendText(
	response: ServerResponse,
	status: number,
	body: string,
	contentType: string,
): void {
	response.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
