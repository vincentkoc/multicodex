import process from "node:process";

import { attachLocalStdio, spawnLocalPty } from "@openclaw/libterminal/node";

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
	const outputDecoder = new TextDecoder();
	const terminal = await spawnLocalPty({
		command: input.command,
		args: input.args,
		cwd: input.cwd,
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
	return { done, kill: () => terminal.kill() };
}

function terminalColumns(): number {
	return Math.max(20, process.stdout.columns || 120);
}

function terminalRows(): number {
	return Math.max(10, process.stdout.rows || 34);
}
