import type { Participant, Room } from "./domain.ts";
import { HttpError, readBoundedText } from "./http.ts";

export async function ensureRoomBranches(
	env: Env,
	room: Room,
	participants: Participant[],
): Promise<void> {
	if (!env.GITHUB_TOKEN) return;
	const [owner, repo] = room.repo.split("/");
	if (!owner || !repo) throw new HttpError(400, "repo must be owner/name");
	const base = await githubJson<{ object: { sha: string } }>(
		env,
		`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(room.baseBranch)}`,
	);
	const branches = [
		room.integrationBranch,
		...participants.flatMap((participant) => (participant.branch ? [participant.branch] : [])),
	];
	for (const branch of new Set(branches)) {
		await githubJson(env, `/repos/${owner}/${repo}/git/refs`, {
			method: "POST",
			body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
			headers: { "content-type": "application/json" },
		}).catch((error) => {
			if (error instanceof HttpError && error.message.includes("422")) return;
			throw error;
		});
	}
}

async function githubJson<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"user-agent": "multicodex",
			"x-github-api-version": "2022-11-28",
			...init.headers,
		},
	});
	const text = await readBoundedText(response, 256 * 1024);
	if (!response.ok)
		throw new HttpError(502, `GitHub ${response.status}: ${text || "request failed"}`);
	return text ? (JSON.parse(text) as T) : ({} as T);
}
