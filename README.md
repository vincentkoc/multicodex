# MultiCodex

MultiCodex is a self-contained multiplayer control room for normal local Codex
sessions. One person hosts the room and conductor. Everyone else joins with
their own Codex installation, authentication, repository, tools, and local
terminal.

The browser shows a live structured view of each lane and gives the host
visible, policy-controlled coordination actions. It does not proxy a raw
terminal or answer local Codex approvals.

## Quickstart

Requirements:

- Node.js 22.13 or newer
- a working `codex` CLI
- the same repository available on each participant machine

Start a room from the repository:

```bash
npx --yes @vincentkoc/multicodex@latest doctor
npx --yes @vincentkoc/multicodex@latest host --repo . --title "OpenAI event build"
```

Open the printed control URL. Use **add a person** to copy a named invite
command:

```bash
npx --yes @vincentkoc/multicodex@latest join '<invite-url>' \
  --repo . \
  --name Queenie \
  --policy suggest
```

The join command launches a normal local Codex TUI. Running the same command
again resumes the same MultiCodex lane and Codex thread. Add `--fresh` only to
create a new lane intentionally.

## Multi-Machine Rooms

The host binds to loopback by default. For a trusted LAN, Tailscale network, or
tunnel, bind a reachable interface and advertise the participant-facing URL:

```bash
npx --yes @vincentkoc/multicodex@latest host \
  --repo . \
  --bind 0.0.0.0 \
  --public-url https://multicodex.example
```

`--public-url` can point at a LAN/Tailscale address or a temporary tunnel. The
room server and conductor still run on the host machine.

## What The Host Can Do

The control room keeps the team rail, selected lane activity, and conductor
conversation visible together.

- add people with named copyable invite commands;
- remove a lane and revoke its capability;
- inspect coalesced messages, plans, commands, file changes, approvals, and
  turn state;
- ask the host-local conductor a room question;
- send a visible suggestion;
- request status;
- start a follow-up Codex turn;
- steer an active turn;
- interrupt an active turn.

Every action is checked against the participant's local policy:

| Policy    | Suggest | Status | Follow-up | Steer | Interrupt |
| --------- | ------- | ------ | --------- | ----- | --------- |
| `observe` | no      | no     | no        | no    | no        |
| `suggest` | yes     | yes    | no        | no    | no        |
| `steer`   | yes     | yes    | yes       | yes   | yes       |

The host cannot answer local command, file, network, or permission approvals.

## Security Model

MultiCodex creates separate random capabilities for the host browser, room
invite, and each lane.

- The host capability protects conductor controls and participant removal.
- The invite capability creates new lanes.
- A lane capability resumes one lane, publishes its events, and receives its
  permitted commands.
- Removing a lane revokes its capability and disconnects its managed bridge.
- Capabilities do not appear in public room snapshots.
- The participant's Codex app-server always binds to loopback.
- Repository contents, credentials, hidden reasoning, and complete terminal
  streams are not published.

Room and lane state is written under `.multicodex/` with owner-only
permissions.

## Repository Development

Run the CLI directly from this repository:

```bash
pnpm install
pnpm multicodex doctor
pnpm multicodex host --repo .
```

Use the printed `dev join` command for a second terminal. The production-style
join command uses `npx --yes @vincentkoc/multicodex@latest`.

Checks:

```bash
pnpm check
pnpm build
npm pack --dry-run
```

## Architecture

```text
Host browser -> host capability -> multicodex host
                                  |- local HTTP room server + durable state
                                  |- ACPx persistent conductor
                                  `- visible lane command router

multicodex join -> lane capability -> room server
      |
      |- local event spool and policy enforcement
      |- loopback Codex app-server
      `- normal local Codex TUI
```

Crabfleet, Crabbox, server OpenAI keys, server GitHub tokens, and hosted
terminals are not required by the self-contained product.

The repository still contains the earlier Cloudflare/Crabfleet event-room
implementation while the local-first replacement lands. It is not the default
MultiCodex runtime.

## Legacy Worker Development

The earlier Worker product remains testable during replacement:

```bash
pnpm db:local
pnpm dev
```

`pnpm dev` enables simulation only for the local Wrangler process. Production
keeps simulation explicitly disabled.
