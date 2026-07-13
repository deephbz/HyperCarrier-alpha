# Architecture and authority boundaries

```text
Pi Sessions + lifecycle leases + tmux + OS processes
                       |
                       v
             apps/timeline collector
                       |
                  read-only APIs
                       |
               timeline / Alpha UI

recent assistant final messages
             |
             v
packages/hc-recent-output  ----> append-only summary JSONL
                                      |
Beads + Git + Markdown ---------------+
                                      v
                         packages/hc-project-distill
                                      |
                         events + proposal bundles
```

## Component responsibilities

### Timeline application

Collects metadata from native Pi JSONL, lifecycle leases, tmux, process state,
PiTeams runtime metadata, configured summary/event streams, proposal bundles,
and read-only Beads export. It owns projections and diagnostics, not the facts
it displays.

### Recent-output extension

Selects the latest eligible assistant final messages and asks a configurable
model for one compact reported-output summary. It excludes user messages,
reasoning, tool calls, tool arguments, and tool results. The output is lossy and
does not determine liveness, priority, delivery, or intervention.

### Project distiller

Reads an explicit Project registry and materializes deterministic, append-only
Project events from Beads, Git, summaries, and Markdown sources. Optional model
synthesis produces a separate proposal bundle. Canonical Markdown is never
mutated automatically.

### PiTeams

PiTeams remains a separate public orchestration component. HyperCarrier reads
its runtime metadata and can project its Beads-backed Tasks; it does not take
over teammate spawn, membership, or messaging.

## Data exposure

The timeline APIs intentionally omit prompt text, assistant text, reasoning,
tool arguments/results, terminal output, and full process command lines.
Metadata is still sensitive and the services remain loopback-only by default.

