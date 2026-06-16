# MultiCodex contributor instructions

## Product

MultiCodex is a self-contained multiplayer control room for normal local Codex
sessions. Keep the default runtime host-local: the host process owns the room
server and ACPx conductor, while each participant bridge owns its loopback
Codex app-server, policy, normal TUI, and local credentials.

Crabfleet and the earlier Cloudflare Worker remain legacy compatibility
surfaces. Do not make them required by the CLI-first product.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Boundaries

- Keep local room and lane state durable, atomic, redacted, and capability
  scoped.
- Keep Codex app-server listeners on loopback.
- Never expose local Codex, repository, or service credentials to browsers.
- Keep host, invite, and lane capabilities distinct.
- Conductor and participant actions must be visible in room activity.
- Participant policy remains authoritative for suggestions and steering.
- Removing a lane revokes it and disconnects only its managed processes.
- Do not kill unrelated local Codex, terminal, or app-server processes.
- Use ASCII in source and documentation.

## Frontend

- Build the usable room workbench, not a marketing landing page.
- Keep room chat always reachable.
- Preserve a dense, playful event-control-room feel without dark neon or
  decorative gradients.
- Use icons for compact controls and visible labels for primary commands.
- Verify desktop and mobile observer/chat layouts before handoff.
