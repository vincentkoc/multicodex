import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TerminalAsset = {
	body: Buffer;
	contentType: string;
};

const ghosttyModulePath = fileURLToPath(import.meta.resolve("ghostty-web"));
const ghosttyDistPath = path.dirname(ghosttyModulePath);
const terminalAssets = new Map<string, { path: string; contentType: string }>([
	[
		"/vendor/ghostty-web.js",
		{ path: ghosttyModulePath, contentType: "text/javascript; charset=utf-8" },
	],
	[
		"/vendor/ghostty-vt.wasm",
		{
			path: fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
			contentType: "application/wasm",
		},
	],
	[
		"/vendor/__vite-browser-external-2447137e.js",
		{
			path: path.join(ghosttyDistPath, "__vite-browser-external-2447137e.js"),
			contentType: "text/javascript; charset=utf-8",
		},
	],
]);

export async function readTerminalAsset(pathname: string): Promise<TerminalAsset | null> {
	const asset = terminalAssets.get(pathname);
	if (!asset) return null;
	return { body: await fs.readFile(asset.path), contentType: asset.contentType };
}
