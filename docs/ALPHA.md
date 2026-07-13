# Alpha operation

## Synthetic mode

Synthetic mode is the safest first test:

```sh
npm ci
npm run build:timeline
npm start
```

Open `/alpha?demo=1` or `/?demo=1`. Synthetic mode is browser-selected and
does not read a real Project registry for those views. The same local process
still exposes its normal metadata APIs, so use an empty `HOME` when testing in
an environment where no local Session discovery is desired.

## Project registry

Real Project projection is opt-in through an explicit v1 registry:

```sh
cp config/project-registry.example.json config/project-registry.local.json
PI_TIMELINE_PROJECT_REGISTRY="$PWD/config/project-registry.local.json" npm start
```

Keep that local file out of Git. Paths may be relative to the registry file.
Project IDs must be stable and unique. Session and Task associations are
explicit; repository/cwd proximity is not association evidence.

## APIs

- `GET /api/snapshot` — session/runtime metadata projection;
- `GET /api/events` — SSE invalidation stream;
- `GET /api/trace` — collection and correlation diagnostics;
- `GET /api/alpha/snapshot` — Project projection;
- `GET /api/alpha/events` — Project-source invalidation stream;
- `GET /api/alpha/trace` — Project-source diagnostics.

## Optional commands

- `pi` enables Session export and the lifecycle extension;
- `tmux` enables live pane/process topology;
- `bd` enables read-only Beads Task projection;
- PiTeams adds teammate/runtime metadata.

Missing optional commands should degrade to explicit unknown/diagnostic state.
