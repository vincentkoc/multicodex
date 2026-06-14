import type { Participant, Room } from "./domain.ts";
import { HttpError, readBoundedText } from "./http.ts";

class GitHubRequestError extends HttpError {
	readonly upstreamStatus: number;

	constructor(upstreamStatus: number, detail: string) {
		super(502, `GitHub ${upstreamStatus}: ${detail || "request failed"}`);
		this.name = "GitHubRequestError";
		this.upstreamStatus = upstreamStatus;
	}
}

export async function resolveRepoDefaultBranch(env: Env, repository: string): Promise<string> {
	const [owner, repo] = repository.split("/");
	if (!owner || !repo) throw new HttpError(400, "repo must be owner/name");
	const result = await githubJson<{ default_branch?: unknown }>(env, `/repos/${owner}/${repo}`);
	if (typeof result.default_branch !== "string" || !result.default_branch.trim()) {
		throw new HttpError(502, "GitHub did not return a default branch");
	}
	return result.default_branch;
}

export async function ensureRoomBranches(
	env: Env,
	room: Room,
	participants: Participant[],
): Promise<void> {
	if (!env.GITHUB_TOKEN) return;
	const [owner, repo] = room.repo.split("/");
	if (!owner || !repo) throw new HttpError(400, "repo must be owner/name");
	const baseSha = await readBranchSha(env, owner, repo, room.baseBranch);
	if (!baseSha) throw new HttpError(502, "GitHub base branch was not found");
	const branches = [
		room.integrationBranch,
		...participants.flatMap((participant) => (participant.branch ? [participant.branch] : [])),
	];
	for (const branch of new Set(branches)) {
		const existingSha = await readBranchSha(env, owner, repo, branch);
		if (existingSha) {
			if (existingSha !== baseSha) {
				throw new HttpError(409, `GitHub branch ${branch} already exists at an unexpected commit`);
			}
			continue;
		}
		try {
			const created = await githubJson<unknown>(env, `/repos/${owner}/${repo}/git/refs`, {
				method: "POST",
				body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
				headers: { "content-type": "application/json" },
			});
			if (refSha(created) !== baseSha) {
				throw new HttpError(502, `GitHub did not create branch ${branch} at the requested commit`);
			}
		} catch (error) {
			if (!(error instanceof GitHubRequestError) || error.upstreamStatus !== 422) throw error;
			if ((await readBranchSha(env, owner, repo, branch)) !== baseSha) throw error;
		}
	}
}

async function readBranchSha(
	env: Env,
	owner: string,
	repo: string,
	branch: string,
): Promise<string | null> {
	try {
		return refSha(
			await githubJson<unknown>(
				env,
				`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
			),
		);
	} catch (error) {
		if (error instanceof GitHubRequestError && error.upstreamStatus === 404) return null;
		throw error;
	}
}

function refSha(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("object" in value)) return null;
	const object = value.object;
	if (!object || typeof object !== "object" || !("sha" in object)) return null;
	return typeof object.sha === "string" && object.sha ? object.sha : null;
}

async function githubJson<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(15_000),
		headers: {
			accept: "application/vnd.github+json",
			...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
			"user-agent": "multicodex",
			"x-github-api-version": "2022-11-28",
			...init.headers,
		},
	});
	const text = await readBoundedText(response, 256 * 1024);
	if (!response.ok) throw new GitHubRequestError(response.status, text);
	return text ? (JSON.parse(text) as T) : ({} as T);
}
