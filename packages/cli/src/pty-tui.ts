import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { IDisposable, IPty } from "node-pty";

export type MirroredTui = {
	done: Promise<void>;
	kill: () => void;
};

export async function startMirroredTui(input: {
	command: string;
	args: string[];
	cwd: string;
	onOutput: (data: string) => void;
	onResize: (columns: number, rows: number) => void;
}): Promise<MirroredTui> {
	await ensureNodePtySpawnHelperExecutable();
	const ptyModule = await import("node-pty");
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const terminal = ptyModule.spawn(input.command, input.args, {
		name: process.env.TERM || "xterm-256color",
		cols: terminalColumns(),
		rows: terminalRows(),
		cwd: input.cwd,
		env: environment,
	});
	const subscriptions: IDisposable[] = [];
	const stdin = process.stdin;
	const previousRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
	const inputHandler = (data: Buffer) => terminal.write(data.toString("utf8"));
	const resizeHandler = () => {
		resizeTerminal(terminal);
		input.onResize(terminalColumns(), terminalRows());
	};
	subscriptions.push(
		terminal.onData((data) => {
			process.stdout.write(data);
			input.onOutput(data);
		}),
	);
	if (stdin.isTTY) {
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", inputHandler);
		process.stdout.on("resize", resizeHandler);
	}
	input.onResize(terminalColumns(), terminalRows());
	const done = new Promise<void>((resolve, reject) => {
		subscriptions.push(
			terminal.onExit(({ exitCode, signal }) => {
				for (const subscription of subscriptions) subscription.dispose();
				stdin.off("data", inputHandler);
				process.stdout.off("resize", resizeHandler);
				if (stdin.isTTY) stdin.setRawMode(previousRaw);
				if (exitCode === 0 || signal) resolve();
				else reject(new Error(`Codex TUI exited with ${exitCode}`));
			}),
		);
	});
	return { done, kill: () => terminal.kill() };
}

async function ensureNodePtySpawnHelperExecutable(): Promise<void> {
	if (process.platform === "win32") return;
	const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("node-pty"))));
	for (const candidate of [
		path.join(packageRoot, "build", "Release", "spawn-helper"),
		path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
	]) {
		try {
			await fs.chmod(candidate, 0o755);
			return;
		} catch {}
	}
}

function resizeTerminal(terminal: IPty): void {
	terminal.resize(terminalColumns(), terminalRows());
}

function terminalColumns(): number {
	return Math.max(20, process.stdout.columns || 120);
}

function terminalRows(): number {
	return Math.max(10, process.stdout.rows || 34);
}
