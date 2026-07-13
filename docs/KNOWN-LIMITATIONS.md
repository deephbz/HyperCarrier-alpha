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
- The optional TPS adapter expects a separately built `pi-tps-web` renderer;
  the timeline, live detail, and Alpha Project view do not require it.
- The recent-output provider receives selected assistant final-message text.
  Use a trusted/local provider or do not enable the extension for sensitive
  Sessions.
- The schemas and UI are Alpha contracts and may change without migration
  guarantees.
