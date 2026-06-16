import { spawn } from "node:child_process";
import { join } from "node:path";

const executable = join(
	"node_modules",
	".bin",
	process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);

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
		shell: process.platform === "win32",
	},
);

child.on("error", (error) => {
	console.error(`failed to start esbuild: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
