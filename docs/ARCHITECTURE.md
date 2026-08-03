# Architecture and authority boundaries

```text
Pi Sessions + lifecycle leases + tmux + OS processes
                       |
                       v
             apps/timeline collector
                       |
                  read-only APIs
                       |
                  timeline UI

selected user and assistant Rarebits
             |
             v
packages/hc-rarebit          ----> append-only Rarebit materialization JSONL
         ^
         | exact verified gitlink; compatibility owned by HyperCarrier
         |
@hypercarrier/rarebit (CLI: rarebit), independent public authority

effective Pi prompt + active tools
             |
             v
packages/systemp-prompt-audit ----> immutable JSON snapshot
             |
             +--------------------> deterministic Markdown + HTML reviews
```

## Component responsibilities

### Rarebit source and composition

`@hypercarrier/rarebit` is the independent public source/npm authority and
`rarebit` is its CLI. HyperCarrier consumes the exact verified same-path
`packages/hc-rarebit` gitlink and owns compatibility/integration only. The
Alpha projection is configured as a gitlink without copied child source; its
parent merge and publication remain separate release gates.

### Timeline application

Collects metadata from native Pi JSONL, tmux, process state, PiTeams runtime
metadata, and Rarebit summary sidecars. It owns fleet projections and
diagnostics, not the facts it displays.

### Recent-output extension

Selects the latest eligible assistant final messages and asks a configurable
model for one compact reported-output summary. It excludes user messages,
reasoning, tool calls, tool arguments, and tool results. The output is lossy and
does not determine liveness, priority, delivery, or intervention.

### System Prompt Audit

Registers an operator command in Pi to capture the current effective system
prompt and active tool definitions. The snapshot is immutable JSON evidence.
The separate CLI verifies its payload hash and renders deterministic Markdown
and script-free HTML without a model call. Snapshots and reviews remain
sensitive local artifacts.

### PiTeams

PiTeams remains a separate public orchestration component. HyperCarrier reads
its runtime metadata and can project its Beads-backed Tasks; it does not take
over teammate spawn, membership, or messaging.

## Data exposure

The timeline APIs intentionally omit prompt text, assistant text, reasoning,
tool arguments/results, terminal output, and full process command lines.
Metadata is still sensitive and the services remain loopback-only by default.
