export function repoAllowed(
	repo: string,
	allowedRepos: string | undefined,
	defaultRepo: string | undefined,
): boolean {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false;
	const configured = (allowedRepos || defaultRepo || "")
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	return configured.includes(repo.toLowerCase());
}
