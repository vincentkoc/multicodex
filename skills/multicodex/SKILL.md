---
name: multicodex
description: Join, coordinate, steer, and attach browser previews to a local-first MultiCodex room. Use when given a MultiCodex invite or host URL, asked to collaborate in a room, steer a lane, or expose a browser preview for work in progress.
---

# MultiCodex

MultiCodex coordinates normal local Codex sessions. The room host and each
participant bridge stay on their respective machines. Treat capability URLs as
secrets: do not put them in commits, issues, logs, or messages outside the room.

## Join a room

Use the invite command supplied by the room owner. A normal participant command
looks like:

```sh
npx --yes @vincentkoc/multicodex@latest join '<invite-url>' \
  --repo . --name 'Your name' --policy suggest --terminal-mirror
```

Choose `--policy observe`, `suggest`, or `steer` as the owner requested.
`--terminal-mirror` enables the live terminal view. Add `--terminal-control`
only when the owner and participant explicitly want host typing control.

After connecting, work normally in the local Codex TUI. Room requests appear
there as normal instructions or suggestions.

## Steer a lane

Only a host capability URL can steer another lane. To send a concise instruction:

```sh
npx --yes @vincentkoc/multicodex@latest steer '<host-url>' \
  --lane 'Builder' --text 'Run the focused tests and report the result.'
```

Use the lane ID when names are ambiguous. Respect the lane policy: the
participant remains authoritative for suggestions and steering.

## Attach a preview

When the user says `attach preview`, finish the browser artifact first, then
make it reachable and attach it to the current lane. The bridge sets
`MULTICODEX_LANE_URL` to that lane's private view URL.

If no durable dev server is already running, start one in a named tmux window
so it survives the agent's one-shot shell command:

```sh
tmux new-window -d -n multicodex-preview-<name> \
  "cd <project-dir> && exec <dev-server-command>"
```

Verify its loopback URL before exposing it. Do not stop or reuse another
session's preview window.

```sh
npx --yes @vincentkoc/multicodex@latest preview set "$MULTICODEX_LANE_URL" \
  --url 'http://127.0.0.1:5173'
```

Use a URL the room viewer can reach. For a shared Tailscale room, preserve
existing Serve routes and use an unused HTTPS port for the preview:

```sh
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:<port>
curl -fsS "https://<machine>.ts.net:8443/"
npx --yes @vincentkoc/multicodex@latest preview set "$MULTICODEX_LANE_URL" \
  --url "https://<machine>.ts.net:8443/"
```

Do not reset or replace another room's Tailscale Serve configuration. Choose an
unused port, verify the preview URL before attaching it, and do not attach URLs
with credentials. The room owner opens and refreshes it from the preview pane.
Clear it when it is no longer useful:

```sh
npx --yes @vincentkoc/multicodex@latest preview set "$MULTICODEX_LANE_URL" --clear
```
