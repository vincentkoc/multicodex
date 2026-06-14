interface Env {
	ALLOWED_REPOS?: string;
	OPENAI_API_KEY?: string;
	CRABFLEET_SERVICE_TOKEN?: string;
	CRABFLEET_PROFILE?: string;
	CRABFLEET_RUNTIME?: "container" | "crabbox";
	GITHUB_TOKEN?: string;
}
