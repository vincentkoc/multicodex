#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AlphaRoomSnapshot, LanePolicy } from "../../protocol/src/index.ts";
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
		case "preview":
			await preview(args);
			break;
		case "steer":
			await steer(args);
			break;
		case "skill":
			await skill(args);
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
			onConductorMessage: (text, source) => conductor.message(text, source),
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
	const terminalControl = Boolean(options["terminal-control"]);
	if (noTui && terminalMirror) throw new Error("--terminal-mirror requires the normal Codex TUI");
	if (terminalControl && !terminalMirror) {
		throw new Error("--terminal-control requires --terminal-mirror");
	}
	if (terminalControl && noTui) throw new Error("--terminal-control requires the normal Codex TUI");
	const previewUrl =
		options["preview-url"] === undefined ? undefined : validPreviewUrl(options["preview-url"]);
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
		terminalControl,
		previewUrl,
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

async function preview(args: string[]): Promise<void> {
	const [action, laneUrl] = positionals(args);
	if (action !== "set" || !laneUrl) {
		throw new Error("usage: multicodex preview set <lane-view-url> --url <http(s)-url> [--clear]");
	}
	const options = parseArgs(args);
	const target = laneTarget(laneUrl);
	const previewUrl = options.clear === "true" ? null : validPreviewUrl(options.url);
	const response = await fetch(
		new URL(`/api/lanes/${encodeURIComponent(target.laneId)}/preview`, target.server),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${target.token}`,
			},
			body: JSON.stringify({ previewUrl }),
		},
	);
	if (!response.ok)
		throw new Error(`preview update failed (${response.status}): ${await response.text()}`);
	process.stdout.write(previewUrl ? `preview attached: ${previewUrl}\n` : "preview cleared\n");
}

async function steer(args: string[]): Promise<void> {
	const [hostUrl] = positionals(args);
	const options = parseArgs(args);
	if (!hostUrl || !options.lane || !options.text) {
		throw new Error("usage: multicodex steer <host-url> --lane <id-or-name> --text <instruction>");
	}
	const target = hostTarget(hostUrl);
	const response = await fetch(new URL("/api/snapshot", target.server));
	if (!response.ok) throw new Error(`room lookup failed (${response.status})`);
	const snapshot = (await response.json()) as AlphaRoomSnapshot;
	const requested = options.lane.toLowerCase();
	const matches = snapshot.lanes.filter(
		(lane) => lane.id === options.lane || lane.displayName.toLowerCase() === requested,
	);
	if (!matches.length) throw new Error(`lane not found: ${options.lane}`);
	if (matches.length > 1) throw new Error(`lane name is ambiguous: ${options.lane}`);
	const lane = matches[0]!;
	const command = await fetch(new URL("/api/conductor/command", target.server), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${target.token}`,
		},
		body: JSON.stringify({
			laneId: lane.id,
			kind: "steer_active_turn",
			text: options.text,
		}),
	});
	if (!command.ok) throw new Error(`steer failed (${command.status}): ${await command.text()}`);
	process.stdout.write(`steer sent to ${lane.displayName}\n`);
}

async function skill(args: string[]): Promise<void> {
	const [action] = positionals(args);
	if (action !== "install") throw new Error("usage: multicodex skill install [--dir <skills-dir>]");
	const options = parseArgs(args);
	const skillDirectory = path.resolve(
		options.dir ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "skills"),
	);
	const destination = path.join(skillDirectory, "multicodex", "SKILL.md");
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile(await bundledSkillPath(), destination);
	process.stdout.write(`installed MultiCodex skill: ${destination}\n`);
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

function positionals(args: string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument.startsWith("--")) {
			const next = args[index + 1];
			if (next && !next.startsWith("--")) index += 1;
			continue;
		}
		values.push(argument);
	}
	return values;
}

function capabilityTarget(
	value: string,
	capability: "host" | "lane",
): {
	server: string;
	token: string;
	laneId?: string;
} {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("valid MultiCodex capability URL required");
	}
	const hash = new URLSearchParams(url.hash.slice(1));
	const token = hash.get(capability === "lane" ? "token" : capability);
	if (!token) throw new Error(`a ${capability} capability URL is required`);
	const laneId = hash.get("lane");
	if (capability === "lane" && !laneId) throw new Error("a lane view URL is required");
	url.hash = "";
	return { server: url.toString().replace(/\/$/, ""), token, laneId: laneId ?? undefined };
}

function laneTarget(value: string): { server: string; token: string; laneId: string } {
	const target = capabilityTarget(value, "lane");
	return { server: target.server, token: target.token, laneId: target.laneId! };
}

function hostTarget(value: string): { server: string; token: string } {
	const target = capabilityTarget(value, "host");
	return { server: target.server, token: target.token };
}

function validPreviewUrl(value: string | undefined): string {
	if (!value) throw new Error("--url <http(s)-url> is required unless --clear is supplied");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("preview URL must be a valid http or https URL");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("preview URL must be an http or https URL without credentials");
	}
	return url.toString();
}

async function bundledSkillPath(): Promise<string> {
	const candidates = [
		fileURLToPath(new URL("../../../skills/multicodex/SKILL.md", import.meta.url)),
		fileURLToPath(new URL("../skills/multicodex/SKILL.md", import.meta.url)),
	];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// The source tree and package layout have different relative paths.
		}
	}
	throw new Error("bundled MultiCodex skill was not found");
}

function help(): void {
	process.stdout.write(`MultiCodex self-contained room

Usage:
  multicodex doctor
  multicodex host --repo . [--port 7331] [--bind 127.0.0.1] [--public-url <url>]
  multicodex join <invite-url> --repo . --name Builder [--policy observe|suggest|steer]
  multicodex status [room-url]
  multicodex steer <host-url> --lane <id-or-name> --text <instruction>
  multicodex preview set <lane-view-url> --url <http(s)-url>
  multicodex preview set <lane-view-url> --clear
  multicodex skill install [--dir <skills-dir>]

Options:
  --no-tui           connect the bridge without launching the normal Codex TUI
  --terminal-mirror  share an ephemeral read-only TUI mirror with the room
  --terminal-control explicitly allow the host to type into this mirrored TUI
  --prompt <text>    start a builder turn after connecting
  --preview-url <url> attach a per-lane browser preview when joining
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
