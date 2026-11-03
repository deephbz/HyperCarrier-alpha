# Arc v2.1

- **Purpose:** tell the owner where one Session's work is and what needs a decision, with citations.
- **Scope:** a private, disposable reading aid for one Session. Arc creates no Task, Project or execution authority. Session evidence remains authoritative.
- **Status:** consolidation, 2026-11-03. Synthetic checks cover the Builder, resident service, two delayed hub links and panel. Live owner acceptance and Q1–Q3 below remain open. This document does not authorize deployment.

## Owner jobs

| Job | The Arc shows |
| --- | --- |
| Return | Now, Needs you, the agreed Goal, and chapters in order |
| Steer | Requests, rules, decisions and confusions with their states |
| Verify | A citation from each claim to its supporting Session message |

## Authority and data flow

```text
Session Host                                      Client machine
Session JSONL -> published Rarebit selector
              -> Arc service -> Builder -> receipt -> hub read copy -> panel
                    ^                                |
                    +---- Build/Rebuild/Dismiss ------+
```

One Arc service owns construction on each Pi Host. Its identity is the Host user and Pi agent directory. Two hub aliases do not create two services. The local Host uses the same service path without SSH. HC Control controls Sessions; it does not build Arcs. The service is separate from the durable line's pi-durable node.

The carrier-neutral Builder owns accepted commands, per-Session serialization, window checkpoints, recovery and receipt revisions. Its `SourcePort`, `ModelPort`, `Admission` and `Store` interfaces live in `src/arc/core/types.ts`. Pi adapters read the original Session JSONL through the published reader and Rarebit selector. Model calls use the Session Host's exact model, settings and sign-in.

The hub link starts or updates the service through the remote agent. The agent relays data. The hub stores receipt replicas and durable pending commands. It does not run an Arc builder. Opening a panel reads the local replica and usage series without SSH, a Session scan or a model call. A replica never becomes a writer.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Arc | the derived summary of one Session |
| chapter | a consecutive part with one topic or stage; only the newest is open |
| key point | a request, rule, decision or confusion |
| Needs you | key points that wait for the owner |
| citation | a native message ID and a verbatim quote from this Session |
| Rarebits | the published selector's tier-b messages on the active branch |
| Build | one incremental construction job, possibly with several windows |
| Rebuild | an explicit job that reads the selection again without the prior Arc |
| receipt | the committed Arc, Build records and persistent warning state |
| published loss | a new candidate that an accepted window could not add |

Arc has no message predicate of its own. Rarebit owns selection and owner provenance ([D17](../../../docs/decisions.md#d17-arc-builds-only-from-rarebit-messages)). Arc reads no Team or Task data.

## Build and recovery

Each call reads the prior Arc and a bounded window of new Rarebits. Code freezes closed chapters, validates citations, assigns IDs, computes exact chapter usage and commits accepted windows. Chapter times use the first and last valid timestamps within the chapter. Both times are null when no entry has a valid timestamp. An omitted existing key point stays unchanged. A failed edit keeps the complete prior point and its kept mark.

Construction and prompt limits live in `src/arc/core/construct.ts`. `src/shared/arc.ts` owns the answer and receipt types; `src/arc/core/types.ts` owns the Builder ports and recovery data. Calls use at most 80k estimated input tokens, including instructions, and request at most 16k output tokens. New-message windows target 60k tokens. A long message keeps marked head and tail excerpts. Quotes must resolve in retained evidence. The previous open chapter stays available within its bounded tail. Closed chapters use compact context.

The Builder persists call intent before dispatch, records model-child identity before sending the prompt, and saves an answer before validation. Recovery reuses saved answers and checkpoints. A service restart does not repeat a proved completed call. Accepted windows retain source, engine, prompt, model and usage provenance. An engine update records a transition without rewriting earlier provenance.

A failed later window can publish a checkpoint only when it covers more of the same selection than the stored receipt. A failed Rebuild keeps the last good Arc. Only an authoritative source check can prove that history changed. Only that proof requires a Rebuild. An unavailable source causes waiting; it does not prove a branch change. Obsolete work cannot publish.

Process liveness and charge knowledge are separate. A recorded survivor holds capacity until verified exit. Exit releases capacity but does not prove that a call was free. Build records retain measured usage and possible repeat cost. Full-state write cost and Session scan cost remain unmeasured.

A proved-gone child must not regain a held slot after restart. An intent without a recorded child can release capacity without paid-call uncertainty only when the service proves that the child never received the prompt. Wrong-model answers stay uncertain. Post-dispatch errors without usage stay uncertain; errors with usage retain it and can schedule retry. Unknown cost stays unknown. Service recovery checks cover these distinctions with synthetic Pi processes.

### Commands and request outcomes

Each owner press creates one request ID. The initiating hub persists that ID and payload before forwarding and resends them unchanged after reconnect or restart. The Host deduplicates IDs and refuses an ID reused with another payload. Equivalent work has the same source version and requested effect. A Rebuild never joins a weaker incremental job.

| Outcome | What it proves |
| --- | --- |
| not sent | The transport did not send the command |
| unknown | The command may have reached the Host; acceptance is not yet known |
| accepted | The Host durably accepted or joined the command and named its Build |
| refused | The Host rejected the command with a reason |

Acceptance does not prove completion. A late "unknown" reply cannot replace an accepted request with the same ID. Acceptance for an older request cannot resolve a later press. Automatic triggers never populate the panel's owner-request line. Dismiss is also a Host command; an acknowledgement alone does not hide a warning.

### Triggers and admission

The service watches Session files through the published selection. Owner messages and agent stops schedule automatic work when at least four Rarebits exist. Debounce is 20 seconds; automatic cadence is five minutes per Session. Manual Build skips both. A pending job retains its strongest intent across restart. Source cursors deduplicate automatic targets. Failed Builds retain retry times and backoff. Other Sessions can continue when one waits or fails.

**Provisional — Q1:** after the last compatible hub handshake, the service continues automatic work for up to `serviceIdleHours` (default 24 hours), then drains and stops. A crash or Host reboot requires a later hub connection to start it again. v2.1 adds no OS supervisor. The owner has not confirmed the no-hub lifetime.

**Provisional — Q2:** an uncertain paid call pauses automatic Builds for that Session across restart. Only an explicit Build or Rebuild authorizes another attempt that may charge again. It records possible repeat cost. Other Sessions continue. An accepted Build clears the pause. The owner has not selected automatic recovery.

**Provisional — Q3:** one shared limit of eight remains the accepted rule. The service currently supplies a Host-local limit behind `Admission`; that implementation does not satisfy the shared rule across Hosts. Do not claim a global eight-call bound from it. The owner must choose the scope before admission acceptance. Wait counts describe held model calls, including survivors.

### Settings

The Session Host's Pi `settings.json` owns `ampi_arc`; the hub's credentials and model do not substitute for it.

```json
{
  "ampi_arc": {
    "model": "anthropic/claude-haiku-5-5",
    "auto": true,
    "retries": 2,
    "concurrency": 8,
    "serviceIdleHours": 24
  }
}
```

The model is an exact `provider/modelId`, with no fuzzy match. Invalid settings name the file and key. Missing sign-in names the model and auth path. The service checks sign-in before each paid call.

`retries` permits 0–5 extra attempts after an unusable answer; zero disables the Needs-you retry too. `concurrency` and `serviceIdleHours` remain subject to Q3 and Q1. Depth stays tier b; zoom calls and adaptive depth are deferred.

## Validation and loss warnings

Code repairs an item when evidence permits it. It rejects an unusable answer within the configured retry budget. A structurally identifiable new Needs-you candidate gets at most one retry within that same budget. Long owner-directed text stays intact with a repair note. Other dropped new candidates do not cause a retry.

Rejected attempts belong in Build details. Only losses from accepted windows enter the receipt's visible warnings. Each warning identifies its kind, title and source message range and links to the source. Needs you and Key points show these lines outside collapsed Build details. The count distinguishes accepted items from items not added.

A **replacement assessment** is a later accepted key point of the same kind and normalized title, supported by a citation at or after the lost candidate's first source position. In owner terms, the Arc has now assessed that item using evidence from the affected part of the Session. An older same-title point cannot clear the warning. This match does not prove semantic completeness.

A warning clears after a committed Rebuild, a replacement assessment or a durable dismissal. A failed Rebuild does not clear it. Dismissal records the loss ID and the last source position the owner saw. A later loss with the same title remains visible when its range exceeds that bound. The panel never stores a permanent title filter. A refusal appears beside the affected warning.

Kept marks persist until an accepted update replaces the affected item. Delta answers keep omitted existing points. No roll call is required. Arc cannot detect a new point the model omitted entirely, or prove that a real quote supports the model's interpretation. Citation validation proves identity and quote presence only.

## Receipt

`src/shared/arc.ts` owns `ArcReceipt`, Build records and published losses. Receipts retain the covered native entry, selected count, fingerprint, selector version and tier. Equal counts with changed evidence do not prove freshness. A selector or branch change requires authoritative rechecking. Prompt changes keep readable receipts and preserve provenance.

The Host Store atomically commits accepted commands, checkpoints, call records and receipt revisions. The hub's read copy is rebuildable from that authority. Its retention does not authorize deleting Host evidence or rewriting the Host receipt.

Key-point kinds and states determine Needs you in code. The model does not write that flag. Requests that wait for the owner, decisions that require confirmation and open owner-directed confusions enter Needs you. A kept mark warns that a prior item could not be updated; it does not create a new claim.

## Panel

The Session's Arc panel is the only prose surface. Overview receives only Needs-you count, oldest age and staleness. The panel keeps Now, Needs you and Goal above chapters and key-point boards. Goal uses body text size. Citations open the supporting message. The panel preserves open chapters and scroll position across updates. When chapter times are unavailable or invalid, timeline bands show chapter order without a usage stream or time axis. An Arc render fault stays inside the panel. Retry view re-renders the saved Arc without starting a Build. At narrow widths, rows wrap and boards become lists without horizontal scrolling.

`src/shared/arc.ts` owns the wire projection. `web/src/views/arc/ArcStatus.tsx` owns Build and request sentences. Raw diagnostics stay in collapsed details. Key lines include:

| State | Owner line | Why | Owner action |
| --- | --- | --- | --- |
| hub disconnected | Disconnected from the hub. Status as of 04:00. | The browser lost the hub. The Host may still build. | Wait, or reload. |
| Host unreachable | devbox: Host is unreachable since 03:52. Check the SSH connection, then run ampi arc status --host devbox. | The hub dates the outage. Elapsed freezes "as of". | Check SSH. Reads still work. |
| unknown request (link loss) | Build request status unknown. AmPi sends it again when devbox reconnects. | The press may have reached the Host. | None. Do not press again. |
| unknown request (service drain) | Build request status unknown. AmPi sends it again when the Arc service on devbox is ready. | The service deferred the press during drain. The hub keeps it pending. | None. Do not press again. |
| not sent | devbox is not reachable. The Arc cannot build now. | The press never left the hub. | Press Build later. |
| refused (service, stopped example) | Build request refused. devbox: Arc service is stopped. A linked hub restarts it within seconds. | The service became unavailable before the press. The line includes the service cause and hides when the service runs again. | Follow the stated action. Build and Rebuild stay disabled while it cannot build. |
| refused (paused) | Build request refused. Automatic Builds are paused. | The Host turned the press down. Details give the cause. | Open Request details. |
| capacity wait | Waiting for a model slot: 8 of 8 in use (devbox 5, lab 3). | Model calls hold every slot. | None. |
| admission unavailable | Waiting: AmPi cannot check the shared model limit now. | The limit cannot be checked. | None. |
| source unavailable | Waiting: the Session file on devbox cannot be read now. | The Host cannot read the Session file. | Check the file if it lasts. |
| survivor | Waiting for an earlier model process on devbox to end. | An old model call still runs. | None. |
| uncertain call | Automatic Builds paused: the last Build stopped during a model call that may have been charged. Press Build to continue (it may charge again). | A call ended with an unknown charge. | Press Build to accept a possible repeat cost. |
| failed Build | Build failed: model quota reached. Next try 05:00. Showing the last good Arc. Retry Build. | The last Build failed. The old Arc stays. | Wait for the next try, or press Build. |
| lost item | Needs you (0 · 1 not added) and "A recent Build could not add a decision from messages 103–105. Read source." | An accepted window lost a new item. | Read the source. Dismiss after you check it. |
| kept item | May be out of date: a recent Build could not update this. | An update to this item failed. | Read the cited source. |
| older hub | This AmPi is older than devbox. Update it. | The service refuses this hub's build. | Update this AmPi. |
| replacement failed | devbox: AmPi could not replace the older Arc service (`<cause>`). Run ampi arc status --host devbox; the log is `<path>`. | The hub could not replace the older service. | Check status and the named log. |
| stopped | devbox: Arc service is stopped. A linked hub restarts it within seconds. | The service idled out or was stopped. | None. |
| stopping | devbox: Arc service is stopping. It drains Builds for every client; a linked hub restarts it within seconds. | Stop drains work for every linked client. | Wait for drain and restart. |
| fault | devbox: Arc service stopped Builds after an internal error. Run ampi arc stop --host devbox to restart it; a linked hub starts it again within seconds. | The service fenced new Builds. | Restart it. |
| busy | devbox: Arc service holds its lock but does not answer. Run ampi arc status --host devbox before retrying. | The lock owner did not answer. | Check status. |
| error | devbox: Arc maintenance failed: `<cause>`. Run ampi arc status --host devbox; the log is `<path>`. | Maintenance did not finish. | Check status and the named log. |
| no sign-in | devbox: Arc service has no sign-in for anthropic/claude-haiku-5-5. Sign in using `<auth path>`. | The Host has no sign-in for the Arc model. | Sign in on the Host. |
| invalid settings | devbox: Arc settings are invalid. Check ampi_arc.retries in `<settings path>`. | A settings key fails validation. | Fix the key. |
| cannot start | devbox: Arc service cannot start: perl is missing. | A Host prerequisite is missing. | Install it on the Host. |

Host names and counts above are synthetic examples. A healthy matching service stays quiet. `src/arc/service/status.ts` owns shared service-state sentences. The panel adds the hub-owned outage time and uses present-state wording during stop. The CLI warning stays unchanged. The panel also covers updating, fault, stopping, an unresponsive lock owner and maintenance errors. Build mismatch text applies across release lines.

The Build record names the trigger, requester and builder Host, followed by call count, cost and new-chapter counts. Possible repeat cost remains visible. For example: `22:52 · manual from desk · built on devbox · 3 calls · $0.01`. These Host names are synthetic.

Failure text precedes Build details and states when the last good Arc remains. A partial Arc says "Covers N of M messages" through failure, queued retry and building. A retry time appears once. Only building shows an elapsed counter. It starts from Host-measured elapsed and interpolates on a browser-local monotonic clock while status is fresh. A stale sample freezes with its observed time. A browser disconnect means hub disconnection; it does not prove Host failure. Stale status hides the newer-message count.

Service facts, correlated request outcomes and receipt revisions reach this panel through the remote-agent link. A build mismatch reports the required update; it does not invent an empty Arc. A receipt can arrive before its cited transcript bytes. Keep it visible with a not-copied-yet citation state. Panel open never fetches remote evidence synchronously. `test/arc-link.test.ts` checks replication and receipt-ahead-of-copy behavior; browser tests check presentation.

## Service operations and cutover

The Host needs Node (or configured `remoteNode`), Perl for the lock, and Pi in the service environment. State lives under `<agentDir>/ampi-arc/`. One persistent lock inode fences the service for its lifetime. The Node service holds the lock after exec; model children do not inherit it. The lock owner alone cleans a stale socket.

All AmPi clients and servers must run the same build. One service per Host user and agent directory serves every client. A hub link offers its streamed bundle and compares its build stamp with the service:

| Hub build | Link result |
| --- | --- |
| Same | The service serves the hub. |
| Newer | The hub drains the old service, installs its bundle and starts the new service. |
| Older | The service refuses the hub with `This AmPi is older than <host>. Update it.` |

A failed replacement names its cause, the status command and the service log path. Build comparison has one owner in `src/arc/service/engine.ts`. `Stamp` carries `id`, `order` and `line`. Equal IDs identify the same build. Different IDs order by `order`, then lexical ID. Release line does not change this order. The build script derives the line from the presence of `release/public/export-manifest.durable.json`; a build override can select it explicitly. The build needs Git metadata for its order unless an explicit test order is supplied.

Only matching builds exchange Arc snapshots and commands. The lifetime lock serializes installation and startup. A racing older offering cannot replace a newer selection. A build change preserves committed receipts and call provenance. During drain, a known Build or Dismiss ID returns its original outcome. New commands receive a transient refusal. The hub retains these pending commands for replay.

The authorized `/api/health` response includes `hosts[].arcStamp` from the replica's last observed running service. It is null when no service runs or the Host is unreachable. `builds` totals the replicas' queued and completed Builds.

```text
ampi arc status [--json] [--host <id>]
ampi arc stop (--host <id> | --all)
```

Status defaults to all configured Pi Hosts. Stopping Arc drains Builds for every client. A linked hub restarts it within seconds. The hub link owns startup and updates; deployment needs no Arc transition hook. A bad release is fixed by rolling forward.

Cutover requires every v2 hub for a Host to update. On first replica use, the v2.1 hub deletes that Host cache's old `views/arc/` receipts and records completion in `arc-replica/replica.json`. Later starts do not repeat the deletion. Host evidence stays in place. Arc does not edit owner settings.

After the update, each Session's Arc is empty until its first v2.1 Build. Press Build on the Sessions you need now. During the hub run that removes v2 receipts, an empty panel says: "Arcs from the previous version were removed. Build to create this Session's Arc."

## Verification and remaining limits

`test/arc-core.test.ts` checks scheduling and accounting transitions with synthetic ports. `test/arc-service-lock.test.ts` and `test/arc-service-runtime.test.ts` check the real launcher and clean-HOME bundle. On 2026-11-03 the lead recorded runs at `3e559c2a`. The launcher passed on macOS, and on Linux aarch64 and x86_64 (x86_64 emulated). The runtime and adapters passed on macOS and Linux aarch64. The repository does not keep these Linux run records. `test/arc-panel-browser.test.ts` checks presentation against synthetic wire snapshots. None proves real provider billing or live two-hub convergence.

`test/arc-link.test.ts` runs two real hub links through a 300 ms delay shim against one Host and a recording model stub. It checks shared acceptance, one paid call, exact request replay across a hub restart and durable dismissal on both clients. Replica tests check stale status, revision ordering, failed writes and receipts ahead of copied transcripts. Cross-Host admission, real provider billing and live owner Return checks remain unverified.

Performance goals remain under 50 ms p95 panel switch, under 30 seconds and $0.02 for a typical incremental Build, and under three minutes for a 110k-token first Build. Earlier v2 first Builds through the magpie bridge took 334–457 seconds. v2.1 latency, full-state write scale and source-scan scale remain unverified. Owner-labelled Return checks must count false reassurance, missed owner decisions and false escalation separately.
