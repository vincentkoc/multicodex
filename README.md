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

## Room security

- A random per-seat capability authenticates room mutations. Public participant
  IDs are never accepted as credentials.
- Public room snapshots contain the visible collaboration timeline, but never
  Crabfleet root IDs, child session IDs, or workspace URLs.
- An authenticated participant only receives the URL for their own workspace.
- Only the host capability can approve a plan, provision workspaces, nudge a
  session, present, or end a room.
- Active builder seats are capped at six. The Worker is the only component that
  holds OpenAI, GitHub, and Crabfleet service credentials.

## Checks

```bash
pnpm check
```

## Deploy

Configure secrets before the first production deploy:

```bash
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm exec wrangler secret put CRABFLEET_SERVICE_TOKEN
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm deploy
```

`CRABFLEET_SERVICE_TOKEN` must match one of Crabfleet's service tokens. Prefer
the dedicated `CRABBOX_MULTICODEX_TOKEN`; use `CRABBOX_OPENCLAW_TOKEN` only
when a shared service capability is intentional. Use a GitHub token that can
create branches only in the intended event repo.

`CRABFLEET_RUNTIME` selects `container` or `crabbox`. The event deployment uses
the built-in `container` runtime for reliable terminal nudges; switch to
`crabbox` when the external adapter exposes a healthy terminal route.

## Architecture

```text
Browsers -> MultiCodex Worker -> D1 + RoomHub Durable Object
                               -> OpenAI Responses API
                               -> Crabfleet service API -> Crabboxes
                               -> GitHub API
```

The originating product and implementation spec is written to
`~/.spec/2026-06-14_multicodex.md` in the local project workspace.
