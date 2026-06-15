import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { LaneEvent, LanePolicy } from "../../protocol/src/index.ts";

export type PersistedBuilderState = {
	version: 1;
	server: string;
	roomId: string;
	laneId: string;
	token: string;
	displayName: string;
	repo: string;
	policy: LanePolicy;
	sequence: number;
	commandSequence: number;
	threadId: string;
	spool: LaneEvent[];
};

export class BuilderStateStore {
	readonly statePath: string;
	private savePromise: Promise<void> = Promise.resolve();

	constructor(input: { repo: string; server: string; displayName: string; statePath?: string }) {
		this.statePath =
			input.statePath ??
			path.join(
				input.repo,
				".multicodex-alpha",
				"lanes",
				`${safeName(input.displayName)}-${digest(normalizeServer(input.server))}.json`,
			);
	}

	async load(): Promise<PersistedBuilderState | null> {
		try {
			const state = JSON.parse(await fs.readFile(this.statePath, "utf8")) as PersistedBuilderState;
			return state.version === 1 ? state : null;
		} catch (cause) {
			const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
			if (code === "ENOENT") return null;
			throw cause;
		}
	}

	async save(state: PersistedBuilderState): Promise<void> {
		const snapshot = `${JSON.stringify(state, null, 2)}\n`;
		this.savePromise = this.savePromise.then(async () => {
			await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
			const temporary = `${this.statePath}.${process.pid}.tmp`;
			await fs.writeFile(temporary, snapshot, { mode: 0o600 });
			await fs.rename(temporary, this.statePath);
		});
		await this.savePromise;
	}

	async clear(): Promise<void> {
		await this.savePromise;
		await fs.rm(this.statePath, { force: true });
	}
}

export function normalizeServer(server: string): string {
	return new URL(server).toString().replace(/\/$/, "");
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeName(value: string): string {
	return (
		value
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-|-$/g, "") || "builder"
	);
}
