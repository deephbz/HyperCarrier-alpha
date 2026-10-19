# @hypercarrier/durable-team

Pi Team Bright semantics on pi-durable, used by [AmPi](../../apps/ampi/README.md).
It adapts the semantics, not the code. Contract:
the accepted HyperCarrier Team contract.

- `TeamDoc` (`team.state`): the one Task authority for a Team. It lives in the
  lead thread's storage and changes only inside tool commits.
- `TeamLead`, `TeamWorker`, `TeamCore`: extensions. The lead gets the graph
  and Worker tools. Each Worker gets Task tools for its own Tasks. Each Worker
  is a child conversation owned by a background anchor task, so it survives
  the lead's turns, Esc, and a node crash with the same transcript.
- Delivery: every accepted change that must reach an agent is written as a
  `Delivery` in the same commit. A background task then submits it with an
  idempotent request ID and marks it settled. Notices arrive as `team.notice`
  entries, never as human input.
- `graph.ts`: pure Task-graph rules (`applyGraph`, `updateTask`,
  `derivedStatus`, `readyFrontier`, `card`) with typed refusals.

Not ported: the C1 delivery hold. pi-durable places steers and follow-ups only
at turn boundaries.

```sh
node --test packages/durable-team/test/*.test.ts
```
