#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const child = spawn(
	process.execPath,
	["--experimental-strip-types", entry, ...process.argv.slice(2)],
	{
		stdio: "inherit",
	},
);
child.once("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
