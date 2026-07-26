# Known limitations

- The current dependency lock requires Node.js 22.19 or newer.
- The live collector is currently tested primarily on macOS and Unix-like tmux
  environments. Process parsing and socket discovery are not yet portable to
  Windows.
- Project identity and Session/Task association require explicit configuration.
- Runtime, output, Task, delivery, and attention remain separate axes. The
  Alpha has no intervention-assessment producer and may display `Unassessed`.
- Beads version checks used by the current PiTeams integration are best-effort
  stale-write preflights, not atomic compare-and-swap.
- Pi Messenger history is not ingested.
- Full native Live Detail temporarily uses a checked-in Pi 0.80.10 package with the public
  stack-safe exporter patch. It remains Pi-owned native HTML and will be replaced by a conforming
  upstream release after that release passes the same deep-tree and exact-entry regressions.
- The optional TPS adapter expects a separately built `pi-tps-web` renderer;
  the timeline and live detail views do not require it.
- An explicitly configured Rarebit model receives the complete selected user
  and assistant Rarebit prose under the configured summary policy. Use a
  trusted/local provider or leave model synthesis disabled for sensitive
  Sessions.
- The schemas and UI are Alpha contracts and may change without migration
  guarantees.
