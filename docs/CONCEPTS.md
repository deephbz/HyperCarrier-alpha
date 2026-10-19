# Concepts

HyperCarrier keeps identities, evidence classes, and state axes separate, so a
convenient view never becomes an accidental source of truth.

## Identities

- **Project**: a unit of intended work with an outcome and a closure or
  abandonment condition. A repository path is a location, not its identity.
- **Session**: the durable conversation and event lineage. It survives process
  crashes and resumes.
- **Agent**: one durable Session trace. Resume keeps the Agent; fork creates a
  new one with recorded lineage.
- **Process instance**: one ephemeral run of Pi or another tool.
- **Pane**: a current multiplexer location, never Agent identity.
- **Membership and Role**: mutable associations of an Agent with a Team.
- **Task**: a durable work record owned by a Task authority (today, Pi Team
  Bright's graph).
- **Artifact**: an addressable output or source bundle associated with a
  Project.

Correlation uses explicit evidence. When it is ambiguous, the value stays
unknown.

## Evidence classes

- **Historical evidence**: native Session, Git, Task, runtime, and lifecycle
  records. Never replaced.
- **Current context**: audited goals, constraints, decisions, and open
  questions, usually in Markdown.
- **Assessment**: a revisable judgment, such as a Rarebit Summary status or
  whether human attention is needed. It always names its evidence and version.

A **Rarebit** is a sparse, lineage-preserving selection of conversational
evidence from one Session branch. A **Rarebit Summary** is a lossy assessment of
that selection and never replaces it.

## State axes

Process liveness, execution activity, work phase, intervention need, Task
commitment, delivery, and novelty are different axes. None implies another.
There is no universal status.
