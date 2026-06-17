#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { LanePolicy } from "../../protocol/src/index.ts";
import { BuilderBridge } from "./builder.ts";
import { resolveUserCodexPath } from "./codex-path.ts";
import { LocalConductor } from "./conductor.ts";
import { LocalRoomStore, startLocalRoomServer } from "./local-room.ts";

const execFileAsync = promisify(execFile);
const [command = "help", ...args] = process.argv.slice(2);

try {
	switch (command) {
		case "host":
			await host(args);
			break;
		case "join":
			await join(args);
			break;
		case "doctor":
			await doctor();
			break;
		case "status":
			await status(args);
			break;
		default:
			help();
			process.exitCode = command === "help" || command === "--help" ? 0 : 2;
	}
} catch (cause) {
	process.stderr.write(`multicodex: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 1;
}

async function host(args: string[]): Promise<void> {
	const options = parseArgs(args);
	const repo = path.resolve(options.repo ?? ".");
	const port = Number(options.port ?? "7331");
	const bind = options.bind ?? "127.0.0.1";
	const stateDir = path.resolve(options.state ?? path.join(repo, ".multicodex", "host"));
	const store = options.resume
		? await LocalRoomStore.load(stateDir)
		: await LocalRoomStore.create({
				stateDir,
				title: options.title ?? "MultiCodex local alpha",
				repo,
			});
	const conductor = new LocalConductor(store, { repo, stateDir });
	const server = await startLocalRoomServer({
		store,
		port,
		host: bind,
		publicUrl: options["public-url"],
		handlers: {
			onConductorMessage: (text) => conductor.message(text),
			onConductorCommand: (laneId, kind, text) => conductor.command(laneId, kind, text),
		},
	});
	try {
		await conductor.initialize();
	} catch (cause) {
		await server.close();
		throw cause;
	}
	process.stdout.write(
		[
			"",
			"MultiCodex room ready",
			`control: ${server.hostUrl}`,
			`invite: npx --yes @vincentkoc/multicodex@latest join ${shellQuote(server.inviteUrl)} --repo . --name Builder --policy suggest --terminal-mirror`,
			`dev join: pnpm multicodex join ${shellQuote(server.inviteUrl)} --repo . --name Builder --policy suggest --terminal-mirror`,
			"conductor: local ACPx / Codex",
			"runtime: no Crabfleet, Crabbox, server OpenAI key, or GitHub token",
			"",
		].join("\n"),
	);
	await waitForSignal(async () => server.close());
}

async function join(args: string[]): Promise<void> {
	const positional = args.find((arg) => !arg.startsWith("-"));
	const options = parseArgs(positional ? args.filter((arg) => arg !== positional) : args);
	const server = positional ?? options.server ?? "http://127.0.0.1:7331";
	const policy = (options.policy ?? "suggest") as LanePolicy;
	if (!["observe", "suggest", "steer"].includes(policy)) {
		throw new Error("policy must be observe, suggest, or steer");
	}
	const noTui = Boolean(options["no-tui"]);
	const terminalMirror = Boolean(options["terminal-mirror"]);
	if (noTui && terminalMirror) throw new Error("--terminal-mirror requires the normal Codex TUI");
	const codexPath = await resolveUserCodexPath({ explicit: options.codex });
	if (!codexPath) {
		throw new Error(
			"user Codex not found outside package-local dependencies; install Codex or pass --codex",
		);
	}
	const bridge = new BuilderBridge({
		server,
		repo: path.resolve(options.repo ?? "."),
		displayName: options.name ?? process.env.USER ?? "Builder",
		policy,
		codexPath,
		noTui,
		terminalMirror,
		prompt: options.prompt,
		fresh: Boolean(options.fresh),
		statePath: options.state ? path.resolve(options.state) : undefined,
	});
	process.once("SIGINT", () => bridge.stop());
	process.once("SIGTERM", () => bridge.stop());
	await bridge.run();
}

async function doctor(): Promise<void> {
	const checks: Array<[string, boolean, string]> = [];
	const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
	checks.push([
		"Node",
		nodeMajor > 24 ||
			(nodeMajor === 24 && nodeMinor >= 11) ||
			(nodeMajor === 22 && nodeMinor >= 18),
		`${process.version} (requires ^22.18.0 or >=24.11.0)`,
	]);
	const codexPath = await resolveUserCodexPath();
	if (!codexPath) {
		checks.push(["Codex", false, "user install not found outside package-local dependencies"]);
	} else {
		try {
			const { stdout } = await execFileAsync(codexPath, ["--version"]);
			checks.push(["Codex", true, stdout.trim()]);
		} catch {
			checks.push(["Codex", false, "not found"]);
		}
	}
	checks.push(["WebSocket", typeof WebSocket === "function", "Node WebSocket client"]);
	for (const [name, ok, detail] of checks)
		process.stdout.write(`${ok ? "ok" : "fail"}  ${name}: ${detail}\n`);
	if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function status(args: string[]): Promise<void> {
	const server = args.find((arg) => !arg.startsWith("-")) ?? "http://127.0.0.1:7331";
	const response = await fetch(new URL("/api/snapshot", server));
	if (!response.ok) throw new Error(`status failed (${response.status})`);
	process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

function parseArgs(args: string[]): Record<string, string | undefined> {
	const values: Record<string, string | undefined> = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (!argument.startsWith("--")) continue;
		const key = argument.slice(2);
		const next = args[index + 1];
		if (!next || next.startsWith("--")) values[key] = "true";
		else {
			values[key] = next;
			index += 1;
		}
	}
	return values;
}

function help(): void {
	process.stdout.write(`MultiCodex self-contained room

Usage:
  multicodex doctor
  multicodex host --repo . [--port 7331] [--bind 127.0.0.1] [--public-url <url>]
  multicodex join <invite-url> --repo . --name Builder [--policy observe|suggest|steer]
  multicodex status [room-url]

Options:
  --no-tui           connect the bridge without launching the normal Codex TUI
  --terminal-mirror  share an ephemeral read-only TUI mirror with the room
  --prompt <text>    start a builder turn after connecting
  --fresh            create a new lane instead of resuming local lane state
  --state <path>     override the builder lane state file
  --resume           resume the host room state from --state
`);
}

async function waitForSignal(cleanup: () => Promise<void>): Promise<void> {
	await new Promise<void>((resolve) => {
		const stop = () => void cleanup().finally(resolve);
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
