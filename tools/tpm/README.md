# TPM source and procedures

Status: review-pending. Stage: consolidation for source extraction. Input
adapters and assessment quality remain exploratory.

This subtree owns reusable context-store procedures, provisional Pulse
assessments, and processed checkpoints. It does not own source discovery,
harness parsing, Rarebit selection, durable context ratification, deployment,
or external account actions. Runtime state and private configuration stay
outside this source bundle. Installation does not activate a schedule.

## Usage contract

Python 3.9+ and a Unix host with `fcntl` are required. The scripts use the
standard library. Keep these files together. A private launcher can add this
directory to `sys.path` and call the matching module's `main()`.

```sh
python3 tools/tpm/pulse_cycle.py --state /tmp/example-pulse --config /tmp/example-config.json
python3 tools/tpm/pulse.py --state /tmp/example-pulse read
python3 tools/tpm/pulse.py --state /tmp/example-pulse tick --config /tmp/example-config.json
python3 tools/tpm/validate.py --root /tmp/example-store
python3 -m unittest discover -s tools/tpm -p 'test_*.py' -v
```

Paths above are synthetic. Create configuration before running. State must be
owner-only (mode 700), outside version control. The validator always requires
the store root. It never selects a store from its installed location. It checks
the conventional store entries listed in `validate.STORE`; it rejects an empty
store. It is a heuristic validator, not a complete secret detector.

Configuration is JSON. Commands are nonempty argv arrays; no shell executes
these arrays. Use absolute executable and file paths in scheduled deployments.

```json
{
  "refresh_command": null,
  "catalog_command": ["node", "<trace-analytics>/bin/sessions.mjs", "sessions", "--since", "7d", "--format", "json"],
  "rarebit_command": ["rarebit"],
  "assess_command": ["assessment-tool", "--model", "ingestion-model"],
  "synthesize_command": ["assessment-tool", "--model", "synthesis-model"],
  "context_files": [],
  "exclude_ids": [],
  "active_days": 7,
  "max_assessments": 4,
  "max_input_chars": 64000,
  "max_synthesis_chars": 96000
}
```

Configure `refresh_command` only when the catalog needs a separate refresh.
Omitting it or setting it to `null` skips refresh.
Omit `synthesize_command` to disable cross-thread synthesis. Models are caller
choices. `pulse_model.py --model MODEL --pi EXECUTABLE` provides optional Pi
transport; credentials remain with Pi. It accepts one JSON payload on stdin and
returns JSON on stdout. Check its CLI flags against the deployed Pi version.
trace-analytics' session reader owns the harness-log catalog. Configure
`node <trace-analytics>/bin/sessions.mjs sessions --since 7d --format json`.
The reader refreshes its index on each run; set `refresh_command` to `null`.
Replace the placeholder with the installed reader path and use an absolute Node
executable in deployments. Text-free records remain private local metadata.
Session role is inferred and provisional. Rarebit retains its own Pi extraction;
its adoption of the reader is deferred.

Catalog stdout is an array of `{id, harness, role, scratch, path}` records.
IDs must be unique. The current consumer accepts Pi IDs as `pi:SESSION_ID`.
It excludes scratch and roles other than `solo` or `leader`. Other harnesses
remain explicit gaps. It calls Rarebit's existing `extract --session PATH
--json` contract. `selection()` in `pulse.py` validates serialization version,
selector version, exact session ID, count, and entry IDs. It does not implement
selection. Branch-selection and omission guarantees need upstream adapter
verification. Empty selection must not be used to hide an extraction failure.

Assessment commands accept JSON on stdin and return `{summary, claims}`.
Each claim contains `text` and nonempty `anchors` from the supplied allowed
set. The executable limits and prompts live in `pulse.py`.

`read` returns provisional assessments, source coordinates, evidence time,
assessment time, synthesis staleness, and gaps. `tick` returns counts and gaps;
a busy tick returns `{ "busy": true }`. Failed thread work retains its prior
checkpoint. Successful updates can persist when another thread fails. Pending
backfill remains a gap. Changed entries or branches rebuild the assessment.
Processed checkpoints do not acknowledge human reading or durable integration.
The cycle saves bounded health in `last-cycle.json`. Exit 1 indicates failure
or gaps; it does not imply rollback of earlier successful updates.

## Procedures

- [Artifact contract](procedures/artifact-contract.md)
- [Inner loop](procedures/inner-loop.md)
- [Outer loop](procedures/outer-loop.md)
- [Pulse loop](procedures/pulse-loop.md)
- [Source format](procedures/sources.md)

Known secret patterns block model input and persisted assessment output. They
do not prove comprehensive redaction. Selected source prose and prompts are
not stored by Pulse. Assessments can contain paraphrases of sensitive evidence;
review source policy before allowing model egress. Child failure diagnostics
are withheld. No live model or external account check is part of the synthetic
test suite.
