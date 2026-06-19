import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readGhosttyAsset } from "@openclaw/libterminal/node";

type TerminalAsset = {
	body: Uint8Array;
	contentType: string;
};

const libterminalBrowserPath = fileURLToPath(import.meta.resolve("@openclaw/libterminal/browser"));
const libterminalIndexPath = fileURLToPath(import.meta.resolve("@openclaw/libterminal"));
const libterminalProtocolPath = fileURLToPath(
	import.meta.resolve("@openclaw/libterminal/protocol"),
);
const terminalStreamBrowserPath = fileURLToPath(
	new URL("./terminal-stream-client.ts", import.meta.url),
);
const libterminalAssets = new Map([
	["/vendor/libterminal/browser.js", libterminalBrowserPath],
	["/vendor/libterminal/index.js", libterminalIndexPath],
	["/vendor/libterminal/protocol.js", libterminalProtocolPath],
	["/vendor/multicodex-terminal-stream.js", terminalStreamBrowserPath],
]);

export async function readTerminalAsset(pathname: string): Promise<TerminalAsset | null> {
	const libterminalAsset = libterminalAssets.get(pathname);
	if (libterminalAsset) {
		return {
			body: await fs.readFile(libterminalAsset),
			contentType: "text/javascript; charset=utf-8",
		};
	}
	return readGhosttyAsset(pathname);
}
