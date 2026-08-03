# Contributing

Bug reports and focused pull requests are welcome during the Alpha.

`HyperCarrier-alpha` is a generated public release projection. Pull requests
are treated as candidate patches and evidence: accepted changes are first
applied and verified in the private development authority, then returned here
through the sanitized export workflow. Maintainers do not develop features
directly in this checkout.

Before submitting a change:

```sh
npm ci
npm test
npm run build:timeline
npm --workspace pi-session-timeline run format:check
npm --workspace pi-session-timeline run lint
```

Use only synthetic fixtures. Do not commit real Pi Sessions, Project records,
local paths, credentials, generated summaries, system-prompt snapshots or
reviews, or screenshots that contain private metadata.

When reporting a bug, include the smallest sanitized reproduction and the
relevant `/api/trace` diagnostics. Never attach raw private Session content.
