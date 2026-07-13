# Contributing

Bug reports and focused pull requests are welcome during the Alpha.

Before submitting a change:

```sh
npm ci
npm test
npm run build:timeline
npm --workspace pi-session-timeline run format:check
npm --workspace pi-session-timeline run lint
```

Use only synthetic fixtures. Do not commit real Pi Sessions, Project
registries, local paths, credentials, generated summaries/events/proposals, or
screenshots containing private metadata.

When reporting a bug, include the smallest sanitized reproduction and the
relevant `/api/trace` diagnostics. Never attach raw private Session content.

