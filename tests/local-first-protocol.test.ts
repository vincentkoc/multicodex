import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GHOSTTY_ASSET_PATHS } from "@openclaw/libterminal/node";

import {
	createLaneEvent,
	policyAllows,
	requiredPolicyForCommand,
} from "../packages/protocol/src/index.ts";
import { BuilderStateStore, parseRoomEndpoint } from "../packages/cli/src/builder-state.ts";
import { ActivityDeltaBuffer } from "../packages/cli/src/builder.ts";
import { resolveUserCodexPath } from "../packages/cli/src/codex-path.ts";
import { routeConductorCommand } from "../packages/cli/src/conductor.ts";
import { LocalRoomStore, startLocalRoomServer } from "../packages/cli/src/local-room.ts";
import { startMirroredTui } from "../packages/cli/src/pty-tui.ts";
import { TerminalMirrorPublisher } from "../packages/cli/src/terminal-mirror.ts";
import { localRoomHtml } from "../packages/cli/src/ui.ts";

async function readTerminalEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	return readSseEvent(reader, "terminal");
}

async function readSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	event: string,
): Promise<string> {
	const decoder = new TextDecoder();
	let buffered = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) throw new Error("terminal stream ended before a terminal frame arrived");
		buffered += decoder.decode(value, { stream: true });
		const match = buffered.match(new RegExp(`event: ${event}\\ndata: ([^\\n]+)\\n\\n`));
		if (match) return Buffer.from(match[1]!, "base64").toString();
	}
}

test("lane policies keep live steering explicit", () => {
	assert.equal(policyAllows("observe", "suggest"), false);
	assert.equal(policyAllows("suggest", "suggest"), true);
	assert.equal(policyAllows("suggest", "steer_active_turn"), false);
	assert.equal(policyAllows("steer", "steer_active_turn"), true);
	assert.equal(requiredPolicyForCommand("request_interrupt"), "steer");
});

test("builder activity buffers stream deltas into readable events", () => {
	const activity = new ActivityDeltaBuffer();
	activity.append("agent.plan", "Inspect");
	activity.append("agent.plan", " the repo");
	activity.append("agent.message", "Done");
	activity.append("agent.message", ".");
	activity.append("agent.message", "   ");
	assert.deepEqual(activity.drain(), [
		{ kind: "agent.plan", summary: "Inspect the repo" },
		{ kind: "agent.message", summary: "Done." },
	]);
	assert.deepEqual(activity.drain(), []);
});

test("local room renders the live lane and host control surfaces", () => {
	const html = localRoomHtml();
	assert.match(html, /id="terminal-stream"/);
	assert.match(html, /id="ghostty-terminal"/);
	assert.match(html, /\/api\/lanes\/.*\/terminal/);
	assert.match(
		html,
		/const columns=lane\.terminalColumns\|\|lane\.terminalViewColumns\|\|120,rows=lane\.terminalRows\|\|lane\.terminalViewRows\|\|34/,
	);
	assert.match(html, /autoFit:false/);
	assert.doesNotMatch(html, /requestAnimationFrame\(\(\)=>terminal\.fit/);
	assert.ok(html.includes(GHOSTTY_ASSET_PATHS.module));
	assert.match(html, /\/vendor\/libterminal\/browser\.js/);
	assert.match(html, /\/vendor\/multicodex-terminal-stream\.js\?v=0\.3\.3/);
	assert.match(html, /id="invite-dialog"/);
	assert.match(html, /id="invite-form"/);
	assert.match(html, /id="invite-command"/);
	assert.doesNotMatch(html, /id="add-person"/);
	assert.match(html, /\/api\/invites/);
	assert.match(html, /invite ready - waiting to join/);
	assert.match(html, /id="command-form"/);
	assert.match(html, /id="action-button"/);
	assert.match(html, /id="lane-stats"/);
	assert.match(html, /id="preview-pane"/);
	assert.match(html, /id="refresh-preview"[^>]*aria-label="refresh preview"[^>]*>&#8635;/);
	assert.match(
		html,
		/id="open-preview-external"[^>]*aria-label="open preview in a new tab"[^>]*>&#8599;/,
	);
	assert.match(html, /id="close-preview"[^>]*aria-label="close preview"[^>]*>&#215;/);
	assert.doesNotMatch(html, /id="refresh-preview"[^>]*>r</);
	assert.match(html, /conductor-collapsed/);
	assert.match(html, /function syncPreview/);
	assert.match(html, /previewDismissedLaneId/);
	assert.match(html, /renderStats\(\);syncPreview\(\)/);
	assert.match(html, /closePreview\(false\)/);
	assert.match(html, /name="terminalControl"/);
	assert.match(html, /\/terminal-input/);
	assert.match(html, /\/terminal-redraw/);
	assert.match(html, /\/terminal-view-size/);
	assert.match(html, /function canTerminalControl/);
	assert.match(html, /function queueTerminalInput/);
	assert.match(html, /function queueTerminalResize/);
	assert.match(html, /function requestTerminalRedraw/);
	assert.match(html, /function reconnectLiveTerminal/);
	assert.doesNotMatch(html, /queueTerminalResize\(lane\.id,\{columns:terminal\.terminal\.cols/);
	assert.match(html, /live mirror reconnecting/);
	assert.match(html, /function syncCommandControls/);
	assert.match(html, /activeLanes\(\)\.some\(candidate=>candidate\.terminalMirror/);
	assert.match(html, /lane policy does not allow conductor actions/);
	assert.match(html, /lane\.currentTurnId&&lane\.terminalMirror&&lane\.connected/);
	assert.match(html, /sessionStorage\.getItem\('multicodex-host-token'\)/);
	assert.match(html, /sessionStorage\.getItem\('multicodex-lane-token'\)/);
	assert.match(html, /\/api\/conductor\/command/);
	assert.match(html, /\/message'/);
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
	assert.ok(script);
	assert.doesNotThrow(() => new Function(script));
});

test("mirrored bridges report applied viewer geometry as their source size", async () => {
	const builder = await fs.readFile(
		path.join(process.cwd(), "packages/cli/src/builder.ts"),
		"utf8",
	);
	assert.match(
		builder,
		/tui\.resize\(size\.columns, size\.rows\);\s+publisher\.resize\(size\.columns, size\.rows\)/,
	);
});

test("invite fragments are separated from the room server URL", () => {
	assert.deepEqual(parseRoomEndpoint("http://127.0.0.1:7331/#invite=join-capability"), {
		server: "http://127.0.0.1:7331",
		inviteToken: "join-capability",
	});
});

test("Codex resolution ignores package-local adapter binaries", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-codex-path-"));
	const packageBin = path.join(root, "node_modules", ".bin");
	const userBin = path.join(root, "user-bin");
	await fs.mkdir(packageBin, { recursive: true });
	await fs.mkdir(userBin);
	await fs.writeFile(path.join(packageBin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
	await fs.writeFile(path.join(userBin, "codex"), "#!/bin/sh\n", { mode: 0o755 });

	assert.equal(
		await resolveUserCodexPath({ pathValue: [packageBin, userBin].join(path.delimiter) }),
		path.join(userBin, "codex"),
	);
});

test("terminal mirror launches a real local PTY", async () => {
	let output = "";
	let size: [number, number] | null = null;
	const tui = await startMirroredTui({
		command: process.execPath,
		args: ["-e", "process.stdout.write('pty-proof')"],
		cwd: process.cwd(),
		onOutput: (data) => {
			output += data;
		},
		onResize: (columns, rows) => {
			size = [columns, rows];
		},
	});
	await tui.done;
	assert.match(output, /pty-proof/);
	assert.deepEqual(size, [
		Math.max(20, process.stdout.columns || 120),
		Math.max(10, process.stdout.rows || 34),
	]);
});

test("mirrored PTYs accept host-controlled input", async () => {
	let output = "";
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const tui = await startMirroredTui({
		command: process.execPath,
		args: [
			"-e",
			"process.stdin.once('data',data=>{process.stdout.write(data);process.exit(0)});process.stdout.write('ready')",
		],
		cwd: process.cwd(),
		onOutput: (data) => {
			output += data;
			if (output.includes("ready")) ready();
		},
		onResize: () => undefined,
	});
	await started;
	tui.write("pty-input\n");
	await tui.done;
	assert.match(output, /pty-input/);
});

test("mirrored PTYs accept browser viewport resize", async () => {
	let output = "";
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const tui = await startMirroredTui({
		command: process.execPath,
		args: [
			"-e",
			"const{execFileSync}=require('child_process');setTimeout(()=>{process.on('SIGWINCH',()=>{process.stdout.write(execFileSync('sh',['-c','stty size < /dev/tty']).toString());process.exit(0)});process.stdout.write('ready')},100);setTimeout(()=>process.exit(1),1500)",
		],
		cwd: process.cwd(),
		onOutput: (data) => {
			output += data;
			if (output.includes("ready")) ready();
		},
		onResize: () => undefined,
	});
	await started;
	tui.resize(79, 25);
	await tui.done;
	assert.match(output, /25 79/);
});

test("local room acknowledges replayed events once and rejects gaps", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane, token } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "steer",
	});
	const event = createLaneEvent({
		roomId: store.snapshot().id,
		laneId: lane.id,
		sequence: 1,
		kind: "lane.connected",
		summary: "connected",
	});
	assert.equal(await store.appendEvents(lane.id, token, [event]), 1);
	assert.equal(await store.appendEvents(lane.id, token, [event]), 1);
	assert.equal(store.snapshot().events.length, 1);
	await assert.rejects(
		() =>
			store.appendEvents(lane.id, token, [
				createLaneEvent({
					roomId: store.snapshot().id,
					laneId: lane.id,
					sequence: 3,
					kind: "lane.status",
					summary: "gap",
				}),
			]),
		/event gap/,
	);
});

test("conductor commands are ordered per local lane", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane, token } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "steer",
	});
	await store.queueCommand(lane.id, "suggest", "share status");
	await store.queueCommand(lane.id, "steer_active_turn", "keep the demo small");
	const commands = store.commandsAfter(lane.id, token, 0);
	assert.deepEqual(
		commands.map((command) => command.sequence),
		[1, 2],
	);
	assert.equal(commands[1]?.requiredPolicy, "steer");
});

test("conductor starts idle lanes instead of steering a missing turn", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane, token } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "steer",
	});
	assert.deepEqual(routeConductorCommand(store.snapshot(), lane.id, "steer_active_turn"), {
		kind: "start_followup",
		reroutedFromIdleSteer: true,
	});

	await store.appendEvents(lane.id, token, [
		createLaneEvent({
			roomId: store.snapshot().id,
			laneId: lane.id,
			sequence: 1,
			kind: "turn.started",
			summary: "started",
			payload: { turnId: "turn_1" },
		}),
	]);
	assert.deepEqual(routeConductorCommand(store.snapshot(), lane.id, "steer_active_turn"), {
		kind: "steer_active_turn",
		reroutedFromIdleSteer: false,
	});
});

test("lane capability resumes the same lane and event sequence", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane, token } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "suggest",
	});
	await store.appendEvents(lane.id, token, [
		createLaneEvent({
			roomId: store.snapshot().id,
			laneId: lane.id,
			sequence: 1,
			kind: "lane.connected",
			summary: "connected",
		}),
	]);

	const resumed = await store.resumeLane(lane.id, token, {
		displayName: "Builder",
		repo: "repo",
		policy: "steer",
	});
	assert.equal(resumed.lane.id, lane.id);
	assert.equal(resumed.lane.lastEventSequence, 1);
	assert.equal(resumed.lane.policy, "steer");
	await store.appendEvents(lane.id, token, [
		createLaneEvent({
			roomId: store.snapshot().id,
			laneId: lane.id,
			sequence: 2,
			kind: "lane.connected",
			summary: "reconnected",
		}),
	]);
	assert.deepEqual(
		store.snapshot().events.map((event) => event.sequence),
		[1, 2],
	);
});

test("room rejects conductor commands above the lane policy", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "suggest",
	});
	await assert.rejects(
		() => store.queueCommand(lane.id, "steer_active_turn", "change direction"),
		/requires steer policy/,
	);
});

test("host removal revokes lane events, commands, and resume", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const { lane, token } = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "steer",
	});
	await store.removeLane(lane.id);
	assert.equal(store.snapshot().lanes[0]?.removedAt !== null, true);
	await assert.rejects(() => store.resumeLane(lane.id, token, lane), /lane removed by host/);
	await assert.rejects(() => store.appendEvents(lane.id, token, []), /lane removed by host/);
	assert.throws(() => store.commandsAfter(lane.id, token, 0), /lane removed by host/);
	await assert.rejects(
		() => store.queueCommand(lane.id, "suggest", "hello"),
		/lane removed by host/,
	);
});

test("duplicate participant messages remain distinct across lanes", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const first = await store.join({ displayName: "Builder", repo: "repo", policy: "suggest" });
	const second = await store.join({ displayName: "Builder", repo: "repo", policy: "suggest" });

	await store.addParticipantMessage(first.lane.id, first.token, "same update");
	await store.addParticipantMessage(second.lane.id, second.token, "same update");
	await store.addParticipantMessage(second.lane.id, second.token, "same update");

	assert.deepEqual(
		store.snapshot().conductorMessages.map((message) => message.laneId),
		[first.lane.id, second.lane.id],
	);
});

test("local room server separates invite, host, and lane capabilities", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	const server = await startLocalRoomServer({
		store,
		port: 0,
		handlers: {
			onConductorMessage: async () => undefined,
			onConductorCommand: async () => undefined,
		},
	});
	try {
		const rejected = await fetch(new URL("/api/join", server.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ displayName: "Builder", repo: "repo", policy: "suggest" }),
		});
		assert.equal(rejected.status, 401);

		const invite = parseRoomEndpoint(server.inviteUrl).inviteToken!;
		const joined = await fetch(new URL("/api/join", server.url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${invite}`,
			},
			body: JSON.stringify({ displayName: "Builder", repo: "repo", policy: "suggest" }),
		});
		assert.equal(joined.status, 201);
		const payload = (await joined.json()) as { lane: { id: string }; token: string };
		const participantMessage = await fetch(
			new URL(`/api/lanes/${payload.lane.id}/message`, server.url),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${payload.token}`,
				},
				body: JSON.stringify({ text: "hello room" }),
			},
		);
		assert.equal(participantMessage.status, 202);
		assert.deepEqual(store.snapshot().conductorMessages.at(-1), {
			id: store.snapshot().conductorMessages.at(-1)?.id,
			author: "participant",
			authorName: "Builder",
			laneId: payload.lane.id,
			body: "hello room",
			at: store.snapshot().conductorMessages.at(-1)?.at,
		});

		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const hostConfig = await fetch(new URL("/api/host/config", server.url), {
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(hostConfig.status, 200);
		assert.equal(JSON.stringify(await hostConfig.json()).includes("invite="), true);

		const removed = await fetch(new URL(`/api/lanes/${payload.lane.id}`, server.url), {
			method: "DELETE",
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(removed.status, 200);
		const commands = await fetch(new URL(`/api/lanes/${payload.lane.id}/commands`, server.url), {
			headers: { authorization: `Bearer ${payload.token}` },
		});
		assert.equal(commands.status, 410);
	} finally {
		await server.close();
	}
});

test("host creates visible single-use named invites that can be revoked", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-invites-"));
	const store = await LocalRoomStore.create({ stateDir, title: "invites", repo: "repo" });
	const server = await startLocalRoomServer({
		store,
		port: 0,
		handlers: {
			onConductorMessage: async () => undefined,
			onConductorCommand: async () => undefined,
		},
	});
	try {
		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const create = async (displayName: string) => {
			const response = await fetch(new URL("/api/invites", server.url), {
				method: "POST",
				headers: {
					authorization: `Bearer ${hostToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ displayName, policy: "steer", terminalMirror: true }),
			});
			assert.equal(response.status, 201);
			return response.json() as Promise<{
				invite: { id: string };
				inviteUrl: string;
				joinCommand: string;
			}>;
		};
		const named = await create("Queenie");
		assert.match(named.joinCommand, /--name 'Queenie' --policy steer --terminal-mirror/);
		assert.equal(store.snapshot().invites[0]?.displayName, "Queenie");
		assert.equal(
			JSON.stringify(store.snapshot()).includes(parseRoomEndpoint(named.inviteUrl).inviteToken!),
			false,
		);
		const hostConfig = (await (
			await fetch(new URL("/api/host/config", server.url), {
				headers: { authorization: `Bearer ${hostToken}` },
			})
		).json()) as { invites: Array<{ id: string; joinCommand: string }> };
		assert.equal(
			hostConfig.invites.find((invite) => invite.id === named.invite.id)?.joinCommand,
			named.joinCommand,
		);

		const claim = await fetch(new URL("/api/join", server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${parseRoomEndpoint(named.inviteUrl).inviteToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				displayName: "Wrong name",
				repo: "repo",
				policy: "observe",
				terminalMirror: false,
			}),
		});
		assert.equal(claim.status, 201);
		const claimed = (await claim.json()) as {
			lane: { displayName: string; policy: string; terminalMirror: boolean };
		};
		assert.equal(claimed.lane.displayName, "Queenie");
		assert.equal(claimed.lane.policy, "steer");
		assert.equal(claimed.lane.terminalMirror, false);
		const reused = await fetch(new URL("/api/join", server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${parseRoomEndpoint(named.inviteUrl).inviteToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				displayName: "Queenie",
				repo: "repo",
				policy: "steer",
				terminalMirror: true,
			}),
		});
		assert.equal(reused.status, 410);

		const revoked = await create("Vincent");
		const revoke = await fetch(new URL(`/api/invites/${revoked.invite.id}`, server.url), {
			method: "DELETE",
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(revoke.status, 200);
		const afterRevoke = (await (
			await fetch(new URL("/api/host/config", server.url), {
				headers: { authorization: `Bearer ${hostToken}` },
			})
		).json()) as { invites: Array<{ id: string }> };
		assert.equal(
			afterRevoke.invites.some((invite) => invite.id === revoked.invite.id),
			false,
		);
		const revokedJoin = await fetch(new URL("/api/join", server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${parseRoomEndpoint(revoked.inviteUrl).inviteToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				displayName: "Vincent",
				repo: "repo",
				policy: "steer",
				terminalMirror: true,
			}),
		});
		assert.equal(revokedJoin.status, 410);
	} finally {
		await server.close();
	}
});

test("participants can attach an http preview to only their own lane", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-preview-"));
	const store = await LocalRoomStore.create({ stateDir, title: "preview", repo: "repo" });
	const server = await startLocalRoomServer({
		store,
		port: 0,
		handlers: {
			onConductorMessage: async () => undefined,
			onConductorCommand: async () => undefined,
		},
	});
	try {
		const lane = await store.join({
			displayName: "Preview builder",
			repo: "repo",
			policy: "suggest",
			terminalMirror: false,
		});
		const attach = await fetch(new URL(`/api/lanes/${lane.lane.id}/preview`, server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ previewUrl: "http://127.0.0.1:4173/game/" }),
		});
		assert.equal(attach.status, 202);
		assert.equal(store.snapshot().lanes[0]?.previewUrl, "http://127.0.0.1:4173/game/");

		const invalid = await fetch(new URL(`/api/lanes/${lane.lane.id}/preview`, server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ previewUrl: "file:///tmp/game.html" }),
		});
		assert.equal(invalid.status, 400);

		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const hostAttempt = await fetch(new URL(`/api/lanes/${lane.lane.id}/preview`, server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${hostToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ previewUrl: "https://example.test/" }),
		});
		assert.equal(hostAttempt.status, 401);
	} finally {
		await server.close();
	}
});

test("terminal mirror is opt-in, ephemeral, and capability scoped", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-terminal-"));
	const store = await LocalRoomStore.create({ stateDir, title: "terminal", repo: "repo" });
	const lane = await store.join({
		displayName: "Builder",
		repo: "repo",
		policy: "suggest",
		terminalMirror: true,
	});
	const otherLane = await store.join({
		displayName: "Other",
		repo: "repo",
		policy: "suggest",
		terminalMirror: true,
	});
	const server = await startLocalRoomServer({
		store,
		port: 0,
		handlers: {
			onConductorMessage: async () => undefined,
			onConductorCommand: async () => undefined,
		},
	});
	try {
		const ghosttyAsset = await fetch(new URL(GHOSTTY_ASSET_PATHS.module, server.url));
		assert.equal(ghosttyAsset.status, 200);
		assert.match(ghosttyAsset.headers.get("content-type") ?? "", /javascript/);
		const ghosttyWasm = await fetch(new URL(GHOSTTY_ASSET_PATHS.wasm, server.url));
		assert.equal(ghosttyWasm.status, 200);
		assert.equal(ghosttyWasm.headers.get("content-type"), "application/wasm");
		for (const pathname of [
			"/vendor/libterminal/browser.js",
			"/vendor/libterminal/index.js",
			"/vendor/libterminal/protocol.js",
			"/vendor/multicodex-terminal-stream.js",
		]) {
			const asset = await fetch(new URL(pathname, server.url));
			assert.equal(asset.status, 200);
			assert.match(asset.headers.get("content-type") ?? "", /javascript/);
			if (pathname === "/vendor/multicodex-terminal-stream.js") {
				assert.equal(asset.headers.get("cache-control"), "no-store");
				const source = await asset.text();
				await assert.doesNotReject(
					() => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`),
				);
			}
		}

		const terminalUrl = new URL(`/api/lanes/${lane.lane.id}/terminal`, server.url);
		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const rejected = await fetch(terminalUrl);
		assert.equal(rejected.status, 403);
		const crossLaneStream = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${otherLane.token}` },
		});
		assert.equal(crossLaneStream.status, 200);
		const crossLaneReader = crossLaneStream.body!.getReader();
		assert.match(new TextDecoder().decode((await crossLaneReader.read()).value), /^: {4096}\n\n$/);
		const removedViewer = await fetch(new URL(`/api/lanes/${otherLane.lane.id}`, server.url), {
			method: "DELETE",
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(removedViewer.status, 200);
		assert.equal((await crossLaneReader.read()).done, true);
		const removedParticipantRejected = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${otherLane.token}` },
		});
		assert.equal(removedParticipantRejected.status, 403);
		const resized = await fetch(new URL(`/api/lanes/${lane.lane.id}/terminal-size`, server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ columns: 143, rows: 47 }),
		});
		assert.equal(resized.status, 202);
		assert.equal(store.snapshot().lanes[0]?.terminalColumns, 143);
		assert.equal(store.snapshot().lanes[0]?.terminalRows, 47);

		const viewportUrl = new URL(`/api/lanes/${lane.lane.id}/terminal-view-size`, server.url);
		const viewport = await fetch(viewportUrl, {
			headers: { authorization: `Bearer ${lane.token}` },
		});
		assert.equal(viewport.status, 200);
		const viewportReader = viewport.body!.getReader();
		assert.match(new TextDecoder().decode((await viewportReader.read()).value), /^: {4096}\n\n$/);
		const viewportDenied = await fetch(viewportUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ columns: 120, rows: 38 }),
		});
		assert.equal(viewportDenied.status, 401);
		const viewportUpdated = await fetch(viewportUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${hostToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ columns: 120, rows: 38 }),
		});
		assert.equal(viewportUpdated.status, 202);
		assert.deepEqual(JSON.parse(await readSseEvent(viewportReader, "resize")), {
			columns: 120,
			rows: 38,
		});
		assert.equal(store.snapshot().lanes[0]?.terminalViewColumns, 120);
		assert.equal(store.snapshot().lanes[0]?.terminalViewRows, 38);
		await viewportReader.cancel();

		const redrawUrl = new URL(`/api/lanes/${lane.lane.id}/terminal-redraw`, server.url);
		const redraw = await fetch(redrawUrl, {
			headers: { authorization: `Bearer ${lane.token}` },
		});
		assert.equal(redraw.status, 200);
		const redrawReader = redraw.body!.getReader();
		assert.match(new TextDecoder().decode((await redrawReader.read()).value), /^: {4096}\n\n$/);
		const redrawRequested = await fetch(redrawUrl, {
			method: "POST",
			headers: { authorization: `Bearer ${lane.token}` },
		});
		assert.equal(redrawRequested.status, 202);
		assert.equal(await readSseEvent(redrawReader, "redraw"), "\u0001");
		await redrawReader.cancel();

		const output = "\u001b[31mlive terminal\u001b[0m\r\n";
		const published = await fetch(terminalUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/octet-stream",
			},
			body: output,
		});
		assert.equal(published.status, 202);

		const stream = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(stream.status, 200);
		assert.equal(stream.headers.get("content-type"), "text/event-stream");
		assert.equal(stream.headers.get("cache-control"), "no-cache, no-transform");
		const reader = stream.body!.getReader();
		assert.equal(await readTerminalEvent(reader), output);

		assert.equal(JSON.stringify(store.snapshot()).includes("live terminal"), false);
		assert.equal(
			(await fs.readFile(path.join(stateDir, "room.json"), "utf8")).includes("live terminal"),
			false,
		);
		assert.equal(store.snapshot().lanes[0]?.terminalMirror, true);

		const publisher = new TerminalMirrorPublisher(server.url, lane.lane.id, lane.token);
		await publisher.stop();
		const closed = await Promise.race([
			reader.read(),
			new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 500)),
		]);
		assert.equal(closed.done, true);
		assert.equal(store.snapshot().lanes[0]?.terminalMirror, false);
		const revoked = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(revoked.status, 403);
	} finally {
		await server.close();
	}
});

test("terminal control requires a participant opt-in and an active local bridge", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-terminal-control-"));
	const store = await LocalRoomStore.create({ stateDir, title: "terminal control", repo: "repo" });
	const invite = await store.createInvite({
		displayName: "Controller",
		policy: "steer",
		terminalMirror: true,
		terminalControl: true,
	});
	const joined = await store.joinFromInvite(invite.token, {
		displayName: "Controller",
		repo: "repo",
		policy: "steer",
		terminalMirror: true,
		terminalControl: true,
	});
	assert.equal(joined.lane.terminalControl, true);
	const noControl = await store.join({
		displayName: "Observer",
		repo: "repo",
		policy: "steer",
		terminalMirror: true,
	});
	await store.appendEvents(joined.lane.id, joined.token, [
		createLaneEvent({
			roomId: store.snapshot().id,
			laneId: joined.lane.id,
			sequence: 1,
			kind: "lane.connected",
			summary: "connected",
		}),
	]);
	const server = await startLocalRoomServer({
		store,
		port: 0,
		handlers: {
			onConductorMessage: async () => undefined,
			onConductorCommand: async () => undefined,
		},
	});
	try {
		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const inputUrl = new URL(`/api/lanes/${joined.lane.id}/terminal-input`, server.url);
		const denied = await fetch(inputUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${noControl.token}`,
				"content-type": "application/octet-stream",
			},
			body: "blocked",
		});
		assert.equal(denied.status, 403);
		const unavailable = await fetch(inputUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${hostToken}`,
				"content-type": "application/octet-stream",
			},
			body: "before bridge",
		});
		assert.equal(unavailable.status, 409);

		const stream = await fetch(inputUrl, {
			headers: { authorization: `Bearer ${joined.token}` },
		});
		assert.equal(stream.status, 200);
		const reader = stream.body!.getReader();
		assert.match(new TextDecoder().decode((await reader.read()).value), /^: {4096}\n\n$/);
		const accepted = await fetch(inputUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${hostToken}`,
				"content-type": "application/octet-stream",
			},
			body: "host input",
		});
		assert.equal(accepted.status, 202);
		assert.equal(await readSseEvent(reader, "input"), "host input");
		assert.equal(JSON.stringify(store.snapshot()).includes("host input"), false);
		assert.equal(
			store.snapshot().conductorMessages.at(-1)?.body,
			"host terminal control active for Controller",
		);
		await reader.cancel();

		await store.disableTerminalMirror(joined.lane.id, joined.token);
		const revoked = await fetch(inputUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${hostToken}`,
				"content-type": "application/octet-stream",
			},
			body: "after revoke",
		});
		assert.equal(revoked.status, 403);
	} finally {
		await server.close();
	}
});

test("public binding requires an explicit participant-facing URL", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo: "repo" });
	await assert.rejects(
		() =>
			startLocalRoomServer({
				store,
				port: 0,
				host: "0.0.0.0",
				handlers: {
					onConductorMessage: async () => undefined,
					onConductorCommand: async () => undefined,
				},
			}),
		/--public-url is required/,
	);
});

test("builder state persists lane capability, cursors, and replay spool", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-builder-"));
	const statePath = path.join(repo, "lane.json");
	const state = new BuilderStateStore({
		repo,
		server: "http://127.0.0.1:7331/",
		displayName: "Builder",
		statePath,
	});
	const event = createLaneEvent({
		roomId: "room_1",
		laneId: "lane_1",
		sequence: 3,
		kind: "lane.status",
		summary: "buffered",
	});
	await state.save({
		version: 1,
		server: "http://127.0.0.1:7331",
		roomId: "room_1",
		laneId: "lane_1",
		token: "capability",
		displayName: "Builder",
		repo,
		policy: "steer",
		sequence: 3,
		commandSequence: 2,
		threadId: "thread_1",
		spool: [event],
	});
	assert.deepEqual(await state.load(), {
		version: 1,
		server: "http://127.0.0.1:7331",
		roomId: "room_1",
		laneId: "lane_1",
		token: "capability",
		displayName: "Builder",
		repo,
		policy: "steer",
		sequence: 3,
		commandSequence: 2,
		threadId: "thread_1",
		spool: [event],
	});
});

test("public local room snapshots do not expose absolute repository paths", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "multicodex-alpha-"));
	const repo = path.join(os.tmpdir(), "private-home", "demo-repo");
	const store = await LocalRoomStore.create({ stateDir, title: "alpha", repo });
	await store.join({
		displayName: "Builder",
		repo,
		policy: "suggest",
	});
	const snapshot = store.snapshot();
	assert.equal(snapshot.repo, "demo-repo");
	assert.equal(snapshot.lanes[0]?.repo, "demo-repo");
	assert.equal(JSON.stringify(snapshot).includes("private-home"), false);
	assert.equal(JSON.stringify(snapshot).includes("hostToken"), false);
	assert.equal(JSON.stringify(snapshot).includes("inviteToken"), false);
});
