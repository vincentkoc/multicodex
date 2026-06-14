interface Env {
	ALLOWED_REPOS?: string;
	OPENAI_API_KEY?: string;
	CRABFLEET_SERVICE_TOKEN?: string;
	CRABFLEET_PROFILE?: string;
	CRABFLEET_RUNTIME?: "container" | "crabbox";
	EVENT_ACCESS_CODE?: string;
	GITHUB_TOKEN?: string;
	MAX_ACTIVE_ROOMS?: string;
}
