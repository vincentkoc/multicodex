# MultiCodex

MultiCodex is a self-contained multiplayer control room for normal local Codex
sessions. One person hosts the room and conductor. Everyone else joins with
their own Codex installation, authentication, repository, tools, and local
terminal.

The browser shows a live structured view of each lane and gives the host
visible, policy-controlled coordination actions. Participants can additionally
opt into an ephemeral Ghostty terminal mirror. A participant can separately
and explicitly allow the host to type into that local TUI.

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
  --terminal-mirror \
  --terminal-control
```

The join command launches a normal local Codex TUI. `--terminal-control` only
works when the host created an invite that allows it; both sides must opt in.
Running the same command
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

## Agent Workflows

Install the bundled Codex skill on a machine that will participate or operate a
room:

```bash
npx --yes @vincentkoc/multicodex@latest skill install
```

The skill covers joining, respecting lane policy, attaching previews, and
host-authorized remote steering. A host can steer a named lane from a terminal:

```bash
npx --yes @vincentkoc/multicodex@latest steer '<host-url>' \
  --lane 'Builder' \
  --text 'Run the focused tests and report the result.'
```

The host capability URL is private. Do not put it in source control, issue
comments, or build logs.

## Lane Previews

Each lane can attach one HTTP(S) browser preview. The room renders it in a
right-side preview pane, replacing the collapsed conductor pane, with refresh
and open-in-browser controls.

Pass a preview on join:

```bash
npx --yes @vincentkoc/multicodex@latest join '<invite-url>' \
  --repo . --name Builder --policy suggest \
  --preview-url http://127.0.0.1:5173
```

Or attach it later from the participant machine. MultiCodex sets
`MULTICODEX_LANE_URL` for the normal local Codex TUI:

```bash
npx --yes @vincentkoc/multicodex@latest preview set "$MULTICODEX_LANE_URL" \
  --url http://127.0.0.1:5173
```

Use a URL the room viewer can reach. A local `127.0.0.1` URL works when the
viewer is on the participant machine; use the approved LAN, Tailscale, or
tunnel URL for another machine. Clear it when finished with
`preview set "$MULTICODEX_LANE_URL" --clear`.

For a shared Tailscale room, preserve the room's existing Serve route and use
an unused HTTPS port for the preview:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:5173
```

Attach the resulting `https://<machine>.ts.net:8443/` URL. Do not reset or
replace another room's Tailscale Serve configuration.

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
- type into a participant's local terminal only when that invite and that
  participant both enabled terminal control.

The portal adapts to the selected lane state: idle lanes expose **start work**
while active lanes expose **steer active turn** and **interrupt active turn**.
For fast conductor control from the room chat, the host can also send:

```text
/start Patrick Control inspect the failing test
/steer Patrick Control keep the change scoped
/interrupt Patrick Control
```

An idle `/steer` is safely routed into a follow-up turn, rather than silently
failing because there is no active turn to steer. Participant messages cannot
invoke these conductor commands.

Every action is checked against the participant's local policy:

| Policy    | Suggest | Status | Follow-up | Steer | Interrupt |
| --------- | ------- | ------ | --------- | ----- | --------- |
| `observe` | no      | no     | no        | no    | no        |
| `suggest` | yes     | yes    | no        | no    | no        |
| `steer`   | yes     | yes    | yes       | yes   | yes       |

Terminal control sends keystrokes to the participant's local PTY, so it can
interact with local approval prompts. It is limited to the host, visibly
marked in the room, carries no terminal-input replay or persistence, and is
revoked when the participant disables the mirror or the lane is removed.

## Security Model

MultiCodex creates separate random capabilities for the host browser, room
invite, and each lane.

- The host capability protects conductor controls and participant removal.
- The invite capability creates new lanes.
- A lane capability resumes one lane, publishes its events, and receives its
  permitted commands.
- `--terminal-mirror` explicitly shares that lane's rendered terminal output
  with the host and every active room participant.
- `--terminal-control` is a distinct, double opt-in capability: the host adds
  it to the named invite and the participant includes it when joining.
- Terminal bytes are held in a bounded in-memory replay buffer and are never
  written into room state or persisted to disk.
- Terminal input is forwarded only from the host browser to the opted-in
  participant PTY and is never persisted or replayed. Conductor steering still
  uses visible, policy-checked Codex app-server commands.
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
