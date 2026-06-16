import fs from "node:fs/promises";
import path from "node:path";

export async function resolveUserCodexPath(input?: {
	explicit?: string;
	pathValue?: string;
	platform?: NodeJS.Platform;
}): Promise<string | null> {
	if (input?.explicit) return input.explicit;
	const platform = input?.platform ?? process.platform;
	const names = platform === "win32" ? ["codex.cmd", "codex.exe", "codex.bat", "codex"] : ["codex"];
	for (const directory of (input?.pathValue ?? process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory || isPackageBin(directory)) continue;
		for (const name of names) {
			const candidate = path.join(directory, name);
			try {
				await fs.access(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Keep looking for the user's Codex outside package-local bins.
			}
		}
	}
	return null;
}

function isPackageBin(directory: string): boolean {
	return /(^|[/\\])node_modules[/\\]\.bin[/\\]?$/.test(directory);
}
