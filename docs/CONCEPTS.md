# Concepts

HyperCarrier keeps identities and evidence classes separate so a convenient UI
does not become an accidental source of truth.

## Identities

- **Project** — explicit unit of intended work. Repository paths are locations,
  not Project identity.
- **Pi Session** — durable conversation/event lineage that may survive process
  crashes and resumes.
- **Process instance** — ephemeral OS execution of Pi or another tool.
- **tmux pane** — current terminal topology/location, not Agent identity.
- **Task** — durable work record supplied by an external Task engine such as
  Beads.
- **Artifact** — addressable output or source bundle associated with a Project.

The dashboard correlates these identities using explicit registries and
source-specific evidence. It leaves a value unknown when correlation is
ambiguous.

## Evidence classes

- **Historical evidence** — native Session, Git, Beads, runtime, and lifecycle
  records.
- **Current context** — audited Project goals, constraints, decisions, and open
  questions, commonly stored as Markdown.
- **Reported output** — lossy statements derived only from recent assistant
  final messages.
- **Assessment** — revisitable judgment such as whether human attention is
  needed.

Runtime activity, reported progress, Task state, delivery evidence, and human
attention are different axes. None implies another.

