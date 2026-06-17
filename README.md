# MultiCodex

MultiCodex is a self-contained multiplayer control room for normal local Codex
sessions. One person hosts the room and conductor. Everyone else joins with
their own Codex installation, authentication, repository, tools, and local
terminal.

The browser shows a live structured view of each lane and gives the host
visible, policy-controlled coordination actions. Participants can additionally
opt into an ephemeral, read-only Ghostty terminal mirror. Browser viewers
cannot type into the terminal or answer local Codex approvals.

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

Open the printed control URL. Use **invite teammate** to create a visible,
single-use named invite command:

```bash
npx --yes @vincentkoc/multicodex@latest join '<invite-url>' \
  --repo . \
  --name Queenie \
  --policy suggest \
  --terminal-mirror
```

The join command launches a normal local Codex TUI. Running the same command
again resumes the same MultiCodex lane and Codex thread. Add `--fresh` only to
create a new lane intentionally. Remove `--terminal-mirror` to publish only
structured activity.

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

- create, recopy, and revoke named single-use teammate invites;
- remove a participant lane and revoke its capability;
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
- `--terminal-mirror` explicitly shares that lane's rendered terminal output
  with the host and every active room participant.
- Terminal bytes are held in a bounded in-memory replay buffer and are never
  written into room state or persisted to disk.
- Terminal mirrors are read-only. Conductor steering still uses visible,
  policy-checked Codex app-server commands.
- Removing a lane revokes its capability and disconnects its managed bridge.
- Capabilities do not appear in public room snapshots.
- The participant's Codex app-server always binds to loopback.
- Repository contents, credentials, and hidden reasoning are not published.
  Terminal output can contain sensitive text, so participants should only use
  `--terminal-mirror` in rooms they trust.

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
      |- normal local Codex TUI
      `- optional ephemeral read-only PTY mirror
```

Crabfleet, Crabbox, server OpenAI keys, server GitHub tokens, and hosted
terminals are not required by the self-contained product.
