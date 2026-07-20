# Security

HyperCarrier is an experimental, single-user, local-first Alpha. Do not expose
its HTTP services directly to an untrusted network.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting or Security Advisory flow for the
repository. Do not include credentials, private session content, or other
sensitive evidence in a public issue.

## Data boundary

- Raw Pi sessions, tool calls, runtime records, and local Project files remain
  on the operator's machine unless an explicitly configured model provider is
  called.
- An explicitly configured Rarebit model receives the complete selected user
  and assistant Rarebit prose under the configured summary policy. Review that
  provider's privacy terms before enabling synthesis for sensitive work.
- Example configuration contains synthetic identities. Keep real Project
  registries and generated events, summaries, and proposals out of Git.
