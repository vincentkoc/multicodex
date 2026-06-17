import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createLaneEvent,
	policyAllows,
	requiredPolicyForCommand,
} from "../packages/protocol/src/index.ts";
import { BuilderStateStore, parseRoomEndpoint } from "../packages/cli/src/builder-state.ts";
import { ActivityDeltaBuffer } from "../packages/cli/src/builder.ts";
import { resolveUserCodexPath } from "../packages/cli/src/codex-path.ts";
import { LocalRoomStore, startLocalRoomServer } from "../packages/cli/src/local-room.ts";
import { startMirroredTui } from "../packages/cli/src/pty-tui.ts";
import { localRoomHtml } from "../packages/cli/src/ui.ts";

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
	assert.match(html, /\/vendor\/ghostty-web\.js/);
	assert.match(html, /id="add-person"/);
	assert.match(html, /\/api\/invites/);
	assert.match(html, /invite ready - waiting to join/);
	assert.match(html, /id="command-form"/);
	assert.match(html, /sessionStorage\.getItem\('multicodex-host-token'\)/);
	assert.match(html, /sessionStorage\.getItem\('multicodex-lane-token'\)/);
	assert.match(html, /\/api\/conductor\/command/);
	assert.match(html, /\/message'/);
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
	assert.ok(script);
	assert.doesNotThrow(() => new Function(script));
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
	assert.deepEqual(size, [120, 34]);
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
		assert.equal(claimed.lane.terminalMirror, true);
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
		const ghosttyAsset = await fetch(new URL("/vendor/ghostty-web.js", server.url));
		assert.equal(ghosttyAsset.status, 200);
		assert.match(ghosttyAsset.headers.get("content-type") ?? "", /javascript/);
		const ghosttyWasm = await fetch(new URL("/vendor/ghostty-vt.wasm", server.url));
		assert.equal(ghosttyWasm.status, 200);
		assert.equal(ghosttyWasm.headers.get("content-type"), "application/wasm");

		const terminalUrl = new URL(`/api/lanes/${lane.lane.id}/terminal`, server.url);
		const rejected = await fetch(terminalUrl);
		assert.equal(rejected.status, 403);
		const crossLaneStream = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${otherLane.token}` },
		});
		assert.equal(crossLaneStream.status, 200);
		await crossLaneStream.body!.cancel();
		await store.removeLane(otherLane.lane.id);
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

		const hostToken = new URL(server.hostUrl).hash.replace(/^#host=/, "");
		const stream = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${hostToken}` },
		});
		assert.equal(stream.status, 200);
		const reader = stream.body!.getReader();
		const replay = await reader.read();
		assert.equal(new TextDecoder().decode(replay.value), output);

		assert.equal(JSON.stringify(store.snapshot()).includes("live terminal"), false);
		assert.equal(
			(await fs.readFile(path.join(stateDir, "room.json"), "utf8")).includes("live terminal"),
			false,
		);
		assert.equal(store.snapshot().lanes[0]?.terminalMirror, true);

		const optedOut = await fetch(new URL(`/api/lanes/${lane.lane.id}/resume`, server.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${lane.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				displayName: "Builder",
				repo: "repo",
				policy: "suggest",
				terminalMirror: false,
			}),
		});
		assert.equal(optedOut.status, 200);
		assert.equal((await reader.read()).done, true);
		const revoked = await fetch(terminalUrl, {
			headers: { authorization: `Bearer ${hostToken}` },
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
