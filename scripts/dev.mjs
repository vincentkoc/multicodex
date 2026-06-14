import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function start(args) {
	return spawn(pnpm, args, { stdio: "inherit" });
}

const initialBuild = start(["exec", "vite", "build"]);
const initialCode = await new Promise((resolve) => initialBuild.once("exit", resolve));
if (initialCode !== 0) process.exit(initialCode ?? 1);

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === "--") forwardedArgs.shift();
const children = [
	start(["exec", "vite", "build", "--watch"]),
	start(["exec", "wrangler", "dev", ...forwardedArgs]),
];
let stopping = false;

function stop(code) {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	setTimeout(() => process.exit(code), 100);
}

for (const child of children) child.once("exit", (code) => stop(code ?? 1));
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
