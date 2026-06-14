# MultiCodex

MultiCodex is a collaborative hackathon room for people working with Codex.
Every participant gets a Crabfleet-backed Codex workspace while a shared
conductor helps the room plan, communicate, catch dependency conflicts, and
integrate the result.

## Product boundary

- MultiCodex owns rooms, chat, plans, roles, tasks, conductor decisions, and
  GitHub coordination.
- Crabfleet owns Crabbox provisioning, Codex terminal transport, transcripts,
  summaries, and cleanup.

## Local development

```bash
pnpm install
pnpm db:local
pnpm dev
```

Open <http://localhost:8787>.

Without `OPENAI_API_KEY` or Crabfleet service credentials, the local app uses a
deterministic conductor and simulated workspaces so the complete room flow is
still testable.

## Checks

```bash
pnpm check
```

## Deploy

Create the D1 database once, replace the `database_id` in `wrangler.jsonc`, and
configure secrets:

```bash
pnpm exec wrangler d1 create multicodex
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm exec wrangler secret put CRABFLEET_SERVICE_TOKEN
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm deploy
```

`CRABFLEET_SERVICE_TOKEN` must match Crabfleet's `CRABBOX_OPENCLAW_TOKEN`.

## Architecture

```text
Browsers -> MultiCodex Worker -> D1 + RoomHub Durable Object
                               -> OpenAI Responses API
                               -> Crabfleet service API -> Crabboxes
                               -> GitHub API
```

The full product and implementation spec lives at
`~/.spec/2026-06-14_multicodex.md`.
