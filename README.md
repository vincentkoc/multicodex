# MultiCodex

MultiCodex is a collaborative hackathon room for people working with Codex.
Every participant gets a Crabfleet-backed Codex workspace while a shared
conductor helps the room plan, communicate, catch dependency conflicts, and
integrate the result.

## Local-first alpha

The isolated alpha proves MultiCodex can use each participant's existing local
Codex authentication and normal TUI without Crabfleet or Crabbox. The host runs
a persistent ACPx-backed conductor locally. Builder bridges share a loopback
Codex app-server with a normal Codex TUI and publish structured activity to a
localhost room.

Terminal one:

```bash
pnpm multicodex doctor
pnpm multicodex host --repo .
```

Open <http://127.0.0.1:7331>, then run the printed join command in terminal two:

```bash
pnpm multicodex join http://127.0.0.1:7331 --repo . --name Builder --policy steer
```

The builder remains in a normal local Codex TUI. The browser can message the
host-local conductor and ask it to visibly steer an active builder turn. Local
Codex approvals remain in the builder's TUI. The bridge does not override the
user's Codex approval policy, permission profile, or sandbox.

Lane capabilities, the attached thread ID, command cursor, and unacknowledged
event spool persist under `.multicodex-alpha/`. Run the same join command after
disconnecting to resume the same lane and Codex thread. Add `--fresh` only when
you intentionally want a new lane.

The alpha room binds to loopback and leaves the deployed Crabfleet-backed
product unchanged.

Gate 2 verification:

1. Send the builder a harmless task in the normal Codex TUI.
2. Confirm structured turn and message events appear in the browser.
3. While the builder turn is active, use **ask conductor to steer** in the
   browser and confirm the steer appears in that same TUI turn.
4. Exit the builder TUI, rerun the same join command, and confirm the prior
   conversation resumes as one lane without duplicate events.

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
still testable. `pnpm dev` enables simulation only for the local Wrangler
process and uses `DEFAULT_BASE_BRANCH` without calling GitHub. Loaded GitHub
and Crabfleet credentials remain unused while simulation is
enabled. Production keeps simulation explicitly disabled.

## Room security

- A random per-seat capability authenticates room mutations. Public participant
  IDs are never accepted as credentials.
- Room creation is open, source-rate-limited, and bounded by the deployment's
  active-room limit.
- Public room snapshots contain the visible collaboration timeline, but never
  GitHub handles, Crabfleet root IDs, child session IDs, workspace URLs, or
  runtime summaries.
- An authenticated participant only receives the URL for their own workspace.
- Only the host capability can approve a plan, provision workspaces, nudge a
  session, present, or end a room.
- Room WebSockets require the app's origin and close clients that exceed the
  message-rate budget. One-time participant tickets reserve builder capacity
  separately from a bounded, per-source public-view pool.
- Builder and AI seats require the room-specific invite link copied by the host;
  public room links can still admit read-only observers.
- Active builder seats are capped at five. The Worker is the only component that
  holds OpenAI, GitHub, and Crabfleet service credentials.
- Room repositories must appear in the deployment's `ALLOWED_REPOS` list.
  This fences both GitHub branch creation and Crabfleet provisioning.
- Production launch fails closed without GitHub credentials. Only explicit
  local simulation skips branch creation and ownership checks.
- A scheduled cleanup pass stops expired room workspaces and preserves their
  public read-only recaps.

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
pnpm run deploy
```

`CRABFLEET_SERVICE_TOKEN` must match one of Crabfleet's service tokens. Prefer
the dedicated `CRABBOX_MULTICODEX_TOKEN`; use `CRABBOX_OPENCLAW_TOKEN` only
when a shared service capability is intentional. Use a GitHub token that can
create branches only in the intended event repo.

`CRABFLEET_RUNTIME` selects `container` or `crabbox`. The event deployment uses
Crabfleet's built-in `container` runtime because it prepares, authenticates, and
autostarts foreground Codex before exposing the terminal. Use `crabbox` only
with a provider profile that independently guarantees the same Codex-ready
contract.
`CRABFLEET_OWNER` is the trusted service-owned Crabfleet identity applied to
every room session; participant-supplied names and GitHub logins are never used
as Crabfleet owners.

`ALLOWED_REPOS` is a comma-separated deployment allowlist. Keep it narrower
than the GitHub token's repository access.

## Architecture

```text
Browsers -> MultiCodex Worker -> D1 + RoomHub Durable Object
                               -> OpenAI Responses API
                               -> Crabfleet service API -> Crabboxes
                               -> GitHub API
```
