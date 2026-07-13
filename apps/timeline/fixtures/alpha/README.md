# HyperCarrier Alpha v1 fixture

`project-manifest.json` is the explicit association contract. It demonstrates two Projects sharing
one repository root and a third Project spanning two repository roots. Runtime/session associations
are explicit `sessionIds`; the projection never assigns a Project from a cwd basename.

The JSONL files are read-only adapter fixtures. Beads is intentionally not faked by a JSON file: the
adapter invokes `bd -C <root> export --readonly --json`, so a live fixture needs an actual Beads
root or an injected command runner in tests.
