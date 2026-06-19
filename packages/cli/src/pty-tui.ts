import process from "node:process";

import { attachLocalStdio, spawnLocalPty } from "@openclaw/libterminal/node";

export type MirroredTui = {
	done: Promise<void>;
	kill: () => void;
	write: (data: string) => void;
};

export async function startMirroredTui(input: {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	onOutput: (data: string) => void;
	onResize: (columns: number, rows: number) => void;
}): Promise<MirroredTui> {
	const outputDecoder = new TextDecoder();
	const inputEncoder = new TextEncoder();
	const terminal = await spawnLocalPty({
		command: input.command,
		args: input.args,
		cwd: input.cwd,
		env: normalizedEnvironment(input.env),
		size: { columns: terminalColumns(), rows: terminalRows() },
		onOutput: (bytes) => input.onOutput(outputDecoder.decode(bytes, { stream: true })),
	});
	const attached = attachLocalStdio(terminal, {
		onResize: ({ columns, rows }) => input.onResize(columns, rows),
	});
	const done = Promise.all([terminal.exit, attached])
		.then(([exit]) => {
			const trailingOutput = outputDecoder.decode();
			if (trailingOutput) input.onOutput(trailingOutput);
			if (exit.code !== 0 && exit.signal === null) {
				throw new Error(`Codex TUI exited with ${exit.code}`);
			}
		})
		.catch((error: unknown) => {
			terminal.kill();
			throw error;
		});
	return {
		done,
		kill: () => terminal.kill(),
		write: (data) => {
			// The PTY transport accepts bytes; browser terminal input arrives as text.
			const write = terminal.write?.(inputEncoder.encode(data));
			if (write) void write.catch(() => undefined);
		},
	};
}

function normalizedEnvironment(
	environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
	if (!environment) return undefined;
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function terminalColumns(): number {
	return Math.max(20, process.stdout.columns || 120);
}

function terminalRows(): number {
	return Math.max(10, process.stdout.rows || 34);
}
