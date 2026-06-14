# MultiCodex contributor instructions

## Product

MultiCodex is the collaboration layer above Crabfleet. Keep runtime and terminal
transport in Crabfleet; keep rooms, chat, plans, tasks, and conductor behavior
here.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Boundaries

- Keep the room event log in D1 as the product source of truth.
- Use one `RoomHub` Durable Object per room for ordered WebSocket fanout.
- Never expose OpenAI, GitHub, or Crabfleet service credentials to browsers.
- Every Crabfleet read or mutation must include the room root session ID.
- Conductor actions must be visible in room activity.
- Destructive or goal-changing actions require host approval.
- Use ASCII in source and documentation.

## Frontend

- Build the usable room workbench, not a marketing landing page.
- Keep room chat always reachable.
- Preserve a dense, playful event-control-room feel without dark neon or
  decorative gradients.
- Use icons for compact controls and visible labels for primary commands.
- Verify desktop and mobile observer/chat layouts before handoff.
