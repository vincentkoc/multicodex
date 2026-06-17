import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readGhosttyAsset } from "@openclaw/libterminal/node";

type TerminalAsset = {
	body: Uint8Array;
	contentType: string;
};

const libterminalBrowserPath = fileURLToPath(import.meta.resolve("@openclaw/libterminal/browser"));
const libterminalIndexPath = fileURLToPath(import.meta.resolve("@openclaw/libterminal"));
const libterminalAssets = new Map([
	["/vendor/libterminal/browser.js", libterminalBrowserPath],
	["/vendor/libterminal/index.js", libterminalIndexPath],
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
