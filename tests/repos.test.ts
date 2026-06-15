import assert from "node:assert/strict";
import test from "node:test";

import { repoAllowed } from "../src/repos.ts";

test("repo allowlist fences deployment GitHub capabilities", () => {
	assert.equal(repoAllowed("vincentkoc/multicodex", undefined, "vincentkoc/multicodex"), true);
	assert.equal(
		repoAllowed("openclaw/gogcli", "openclaw/gogcli,openclaw/crabfleet", undefined),
		true,
	);
	assert.equal(
		repoAllowed("openclaw/openclaw", "openclaw/gogcli,openclaw/crabfleet", undefined),
		false,
	);
	assert.equal(repoAllowed("../openclaw", "openclaw/gogcli", undefined), false);
});
