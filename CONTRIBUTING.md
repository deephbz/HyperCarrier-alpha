# Contributing

Bug reports and focused pull requests are welcome during the Alpha.

`HyperCarrier-alpha` is a generated public release. Treat pull requests as
candidate patches and evidence. Maintainers apply accepted changes to the
private development source and return them through the export workflow.

Before proposing changes to AmPi or Trace Viewer, read
[Architecture](docs/ARCHITECTURE.md), [Concepts](docs/CONCEPTS.md), and
[Known limitations](docs/KNOWN-LIMITATIONS.md). Run the package checks that
cover the changed component:

```sh
npm ci
npm --workspace @hypercarrier/ampi test
npm --workspace @hypercarrier/ampi run typecheck
npm --workspace @hypercarrier/trace-viewer test
npm run build:ampi
npm run build:trace-viewer
```

Use synthetic fixtures. Do not commit real Pi Sessions, local paths,
credentials, generated summaries, system-prompt snapshots, private reviews, or
screenshots with private metadata.

Report a small sanitized reproduction and relevant diagnostics. Never attach
raw private Session content.
