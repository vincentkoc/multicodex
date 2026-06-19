import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const executable = require.resolve("esbuild/bin/esbuild");

const child = spawn(
	executable,
	[
		"packages/cli/src/index.ts",
		"--outfile=dist/cli.mjs",
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--target=node22",
		"--packages=external",
	],
	{
		stdio: "inherit",
	},
);

child.on("error", (error) => {
	console.error(`failed to start esbuild: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
