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
import { BuilderStateStore } from "../packages/cli/src/builder-state.ts";
import { LocalRoomStore } from "../packages/cli/src/local-room.ts";

test("lane policies keep live steering explicit", () => {
	assert.equal(policyAllows("observe", "suggest"), false);
	assert.equal(policyAllows("suggest", "suggest"), true);
	assert.equal(policyAllows("suggest", "steer_active_turn"), false);
	assert.equal(policyAllows("steer", "steer_active_turn"), true);
	assert.equal(requiredPolicyForCommand("request_interrupt"), "steer");
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
});
