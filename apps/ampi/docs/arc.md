# Arc v2

- **Purpose:** tell the owner where one Session's work is and what it needs from them, in plain words, with a citation for every claim.
- **Scope:** AmPi's derived, disposable summary of one Session. It creates no Task, Project or execution authority. It replaces Arc v1 completely; v1 code, data, settings and docs are deleted, with no compatibility path.
- **Status:** implementation contract, 2026-10-31. Shaped with the owner on a real Session (prototype `~/arc-proto/index.html`, brief `~/.cache/ampi-arc-proto/BRIEF.md`; both private, outside the repository).

## Owner jobs

| Job | Moment | The Arc must show |
| --- | --- | --- |
| Return | The owner comes back to a Session that ran alone | What the work is now, what waits for the owner, the agreed goal, what happened in order |
| Steer | The owner works with the Session | The state of each request, rule, decision and confusion |
| Verify | Either | One click from any claim to the message that supports it |

## Vocabulary

Use these words, and only these, in code, data, prompts, UI and docs.

| Word | Meaning |
| --- | --- |
| Session | one agent conversation; the source of truth |
| Arc | the derived summary of one Session, written for the owner |
| chapter | one consecutive part of a Session with one topic, direction or stage; only the newest chapter is open |
| chapter summary | the structured text of one chapter: scope, then nested bullets |
| key point | one item the owner tracks: a request, rule, decision or confusion |
| Needs you | the key points that wait for the owner |
| citation | a link from a claim to one message of this Session, with a verbatim quote |
| sidecar | the one Arc builder paired with one Session |
| Rarebits | the deterministic message selection the sidecar reads |
| Build | one sidecar run that turns new Rarebits into a new Arc version |
| receipt | the stored Arc version and its Build record |

## Pipeline

```text
Transcript ─select─▶ Rarebits ─build─▶ Arc ─store─▶ Receipt ─render─▶ View
  (Pi or durable)    code: tier b     sidecar     code: validate,     panel: no model
                                      model call   ids, numbers        call on read
```

1. **Select (code).** Rarebits at tier b: owner messages, every agent prose message (continuation and stop), errors and compactions, with native entry IDs, on the active branch. The Rarebit selector (`working-set.ts`, and its durable reader equivalent) stays the only message authority. Arc has no predicate of its own. The owner-turn rule (v1 `isOwnerTurn` and `INJECTED_USER_MESSAGES`: a relayed or harness-injected user message is not an owner message) moves into the selector before v1 is deleted, so every Rarebit carries `owner: boolean`. Extension messages are not inputs in v2.
2. **Build (sidecar, one model call per window).** Input: the previous Arc (if any) and the Rarebits after its cutoff, plus the open chapter's Rarebits. Output: one JSON answer in the shape below. One model, from settings.
3. **Store (code).** Parse, validate, repair what code can repair, assign IDs and numbers, compute every derived figure, write the receipt. A rejected answer never replaces the last good receipt.
4. **Render (web).** The Arc panel reads the receipt and the Session's usage series. No model call on read.

Each sidecar reads only its paired Session. Arc never reads Pi Team Bright, pi-team-durable or Task data.

## Build

### Incremental by default

A Build is incremental: previous Arc plus new Rarebits. This is the base case, because a long Session's Rarebits exceed one context window (a 54-hour Session is about 110k tokens at tier b).

- **First Build:** no previous Arc. The Rarebits are cut into windows of at most `WINDOW_TOKENS` (60k, estimated as characters / 4) at message boundaries. The first window builds from nothing; each next window builds on the previous window's Arc. Each accepted window becomes an in-memory checkpoint. The view keeps the previous receipt while the Build runs. On success, code stores the final receipt. On a later window failure, code stores the last checkpoint with the failed Build record and publishes it once. The checkpoint covers a prefix of the Session; the next Build continues from its cursor. A checkpoint replaces an existing receipt only when it covers more messages on the same selector, tier and branch. A failed Rebuild or selection change keeps a fuller stored receipt. A hub crash during a Build may lose the checkpoint.
- **Closed chapters are frozen.** Code copies every closed chapter of the previous Arc into the next Arc unchanged (label, chapter summary, citations, span). The model sees closed chapters as a compact list (number, label, first entry ID, scope line) and may not rewrite them. Only the open (last) chapter and new chapters come from the model. If the answer changes a closed chapter, code restores it and records a repair.
- **Key points carry across versions.** The model sees every previous key point with its ID. It returns each point it keeps or changes with that ID (`id`), and new points without one. Code assigns new IDs (`K<n>`, never reused, including after Rebuild). A previous point the answer omits stays unchanged. A point can change kind only through a new point; its state may change at any time with a new citation.
- **Input bound per call.** Every call stays under `CALL_INPUT_TOKENS` (80k, estimated as characters / 4), fixed instructions included. The previous Arc goes in compact form, at most `PREV_ARC_TOKENS` (15k): closed chapters as number, label, first entry ID and scope line; key points as ID, kind, state, by, title and first-cite ID (no text, no quotes). When the compact form is over its cap, code leaves out settled points (done, dropped, accepted, reversed, lifted, resolved) from closed chapters, oldest first; they stay in the receipt unchanged. The previous open chapter goes in full (its scope, bullets and cites), so facts from its earlier part survive. Its evidence is limited to its last `OPEN_TAIL_TOKENS` (20k); when the open chapter is longer, the prompt tells the model to close it at a natural break. New Rarebits fill the rest of the window; more new Rarebits than fit become more windows. One Rarebit longer than `MESSAGE_TOKENS` (12k) keeps its first and last 6k with a marked cut; quotes must come from the kept text.
- **Call timeout.** Each Arc model call has an explicit 300-second timeout. This is a failure bound, not the normal latency target.
- **Output bound.** Each call asks for at most `ANSWER_TOKENS` (16k) output tokens. Quotes are at most 200 characters; a claim has at most 3 cites. An answer cut off by the limit is an `answer` failure and retries with the reason.
- **Chapter grain.** The model starts a new chapter where the work's goal or theme changes. Chapter length varies widely, so the prompt sets no chapter count, and code enforces none. An approval or a single check stays in its existing chapter. The Build record lists the new chapters of each accepted window (`newChapters`), and the panel shows them in the Build record line, so a bad cut pattern shows in data. A failed Build can have fewer entries than `windows`, and an old record without the field has unknown counts, not zero.
- **Full rebuild:** the Build op takes `rebuild: true`. It discards the previous Arc and runs the first-Build path. Only the owner's button starts it.

### Model and settings

Pi's global `settings.json` on the hub machine holds the one Arc setting block. The hub reads it at each Build through the existing settings stamp cache (`src/node/pi-config.ts`), so an edit applies without a restart.

```json
{
  "ampi_arc": {
    "model": "anthropic/claude-haiku-5-5",
    "auto": true,
    "retries": 2
  }
}
```

- `model`: one full `provider/modelId` string literal, for example `magpie/claude/claude-haiku-5-5`. Default `anthropic/claude-haiku-5-5`. The call goes through `ask` (`src/pi/ask.ts`) with `resolved: true` semantics: no fuzzy registry match; an answer from another model fails the Build with code `model`. An invalid value fails the Build before any call, with a message that names the file and the key.
- `auto`: automatic triggers on or off. Default `true`. The manual Build button always works.
- `retries`: extra calls per window after an unusable answer, an integer from 0 to 5. Default `2`, so a window makes at most 3 calls.
- No other Arc keys exist. hub.json carries no Arc key; the hub rejects nothing for unknown legacy keys but reads none.

#### Decision TODO: input depth and zoom rounds

Status: open. The current Build reads one fixed depth and makes no zoom call.

- **Now:** depth b. Depth is the Rarebit tier in Pipeline step 1 and the receipt field `tier`. Zoom rounds: zero. No setting exists for either.
- **Proposed settings:** `ampi_arc.depth: "a" | "b" | "c"` sets the starting depth. Depth a selects fewer messages than b, and depth c selects more. `ampi_arc.zoomRounds` (0–2) lets the model ask for more context: its JSON answer returns `needs: [{ from, to, depth }]`, and code answers with that message range at that depth in the next call. This needs no tool calls in `ask`, and code still enforces the input limits.
- **Later target:** adaptive depth. A huge chapter starts at depth a; any other chapter starts at depth c. zoomRounds is 2. Chapter size comes from the previous receipt; a first Build needs an estimate.
- **Open before you build it:** the exact predicates for depths a and c. The Rarebit selector owns them, so Arc does not define its own. Also decide the setting values: the letters can stay as the stored `tier`, while a hand-edited setting may need names that say what they do.
- **Receipt:** the receipt already has a `tier` field, but today it accepts only `b`. Depths a and c, and mixed depths from zoom rounds, still need a decision on how a receipt records them and how older hubs read them.

### Triggers

- **Automatic (default on):** a new Rarebit of kind *agent stop* or *owner message* in a Session with at least `ARC_FLOOR` (4) Rarebits schedules a Build of that Session.
  - Debounce: the Build starts `DEBOUNCE_MS` (20 s) after the last qualifying Rarebit, so an owner message that answers a stop gives one Build.
  - At most one Build per Session runs at a time. A trigger during a Build sets one pending flag; the Build runs again when it ends. Pending work keeps its strongest trigger: Rebuild, then manual, then the latest automatic trigger. A later event never weakens explicit work.
  - Cadence: an automatic Build of a Session starts at most once per `AUTO_INTERVAL_MS` (5 minutes) after its last automatic Build started, whatever the result. Triggers inside that interval set the pending flag; one Build covers them all when the interval ends.
  - Sessions build independently: each has its own pending flag, failures, backoff and retries. Arc keeps no hub-wide Build queue or slot count. A Build that is due starts at once.
  - Model-call capacity is the only shared limit, enforced by admission inside `src/pi/ask.ts` (the shared boundary): at most `ASK_CONCURRENCY` (8) calls run hub-wide, because each call starts one Pi process. Every Arc call is a background call, and background calls hold at most `BACKGROUND_CONCURRENCY` (7) slots. The last slot serves interactive calls, such as a Rarebit Ask: Arc calls never take the last admission slot; other interactive calls can still fill it, and a Rarebit Ask that finds no slot fails busy at once. Admission does not bound how long a provider takes to answer.
  - An Arc call waits up to `ADMISSION_WAIT_MS` (60 s) for a slot. A refusal after that wait shows "Waiting for a model slot", and the Build asks again after `BUSY_RETRY_MS` (1 s), without the cadence or a failure backoff. The busy refusal holds until the retry starts, so an event in the wait does not bring back the cadence or a backoff. A waiting manual Build or Rebuild stays explicit, so turning automatic Builds off does not cancel it. While a call waits for a slot, the panel shows "Waiting for a model slot". Waiting calls take free slots in no fixed order.
  - Backoff after failure: 1, 2, 4 … up to 60 minutes per Session, plus 0–30 s jitter; a success resets it. A quota error with a reset time waits for that time.
  - Pending state is in memory; after a hub restart, a Session whose receipt is older than its Rarebits builds on its next trigger or when a client opens it.
- **Manual:** the panel's **Build** button runs an incremental Build now. It skips the debounce and the cadence and shares model-call admission with automatic Builds. A manual Build of a Session whose Build is running joins that Build. **Rebuild** in the panel's menu runs a full rebuild.
- Both triggers call one entry point, `buildArc(session, { trigger, rebuild })`.

### Answer shape (model-written)

```ts
type ArcAnswer = {
  goal: Claim;              // the agreed goal and limits, 1–2 sentences
  now: Claim;               // where the work is, status first, 2–3 sentences
  chapters: AnswerChapter[]; // the open chapter (if still open or now closed) and any new chapters, oldest first
  points: AnswerPoint[];     // changed and new key points only
};
type Claim = { text: string; cites: Cite[] };
type Cite = { id: string; quote: string };     // native entry ID; quote verbatim from that message
type AnswerChapter = {
  firstId: string;          // entry ID of the chapter's first Rarebit; code derives the span
  label: string;            // 3–6 words; past-tense verb first; the open chapter uses the -ing form
  closed: boolean;          // only the last chapter may be false
  summary: ChapterSummary;
};
type ChapterSummary = {
  scope: Claim;             // goal and scope of this chapter, one sentence
  bullets: Bullet[];        // the adaptive main content
};
type Bullet = { text: string; cites: Cite[]; children?: Bullet[] };  // at most 3 levels
type AnswerPoint = {
  id?: string;              // previous point ID when it continues one
  kind: "request" | "rule" | "decision" | "confusion";
  state: string;            // one of STATES[kind]
  by: "owner" | "agent";    // who raised it (decision: who decided)
  waits?: "owner" | "agent"; // required for open/in progress/blocked requests and open confusions
  title: string;            // 2–6 words, template per kind
  text: string;             // one sentence, at most 140 characters
  cites: Cite[];
};
```

`STATES` (code-owned): request `open | in progress | blocked | done | dropped`; rule `in force | lifted`; decision `confirm | accepted | reversed`; confusion `open | resolved`. An agent question to the owner is a `request` with `by: "agent", waits: "owner"`. Code derives Needs you from one table: request `open`, `in progress` or `blocked` with `waits: "owner"`, decision `confirm`, confusion `open` with `waits: "owner"`. The model never writes a Needs-you flag. Recall floor (code): when the newest agent stop ends with a question and no Needs-you point cites that stop, Needs you adds one item "Unanswered question in the last reply" citing it. Needs you orders `blocked` first, then `confirm`, then the rest, oldest first within each group. The view prints the action label from the state ("Confirm or reverse", "Unblock", "Answer"); the model writes only the fact. An agent decision on a choice the owner delegated ("either is fine") is `accepted`, never `confirm`.

### Chapter summary: fixed structure, adaptive length

Every chapter summary has the same two parts: **scope** (one sentence: the goal and scope of this chapter), then **bullets** (nested at most 3 levels). Length adapts to the chapter. Code computes each chapter's weight and sends it with the chapter, so the model sizes the summary to it:

| Weight input (code) | |
| --- | --- |
| Rarebits in the chapter, owner messages among them | |
| wall time and active time (gaps over 1 h removed) | |
| tokens and dollars spent (exact sum of the chapter's entries) | |
| decisions and requests raised in it | |

Prompt rule: a light chapter (few messages, under ~$1) gets 1–3 top-level bullets and no children. A heavy or complex chapter (many owner turns, decisions, failures and repairs, over ~$10) gets up to 8 top-level bullets, with children where a bullet has parts and grandchildren only for a list inside a part. Never pad: each bullet carries a fact the owner would act on or ask about. The validator enforces depth ≤ 3, at most 8 top-level bullets, at most 6 children per bullet, and 160 characters per bullet.

### Writing rules (prompt)

The reader is the owner: they know the goals, constraints and project ecosystem (HyperCarrier, AmPi, Pi, Herdr, stable and durable lines, public Alpha releases). They do not know words invented during the work: Worker names, gates, lanes, orbs, commit hashes, file, test, function or CSS names. Omit them or say them in plain words. The owner may be tired; each item stands alone.

1. Start each item with its subject or verb (noun-verb-noun). Never a passive or fronted object.
2. Put the words that tell items apart first.
3. One structure per kind, one word per concept ("you" for the owner in the view only — see below; "the agent"; "live"; "released"; "phone"; "stable line"; "durable line").
4. Add a detail only when it means something.
5. Match the verb's tone to the list: Needs-you items start with Confirm, Choose or Check; done items use completion verbs; problems use negative verbs.

Templates: rule = imperative title; request = imperative of the ask, detail starts "Done:" / "Open:"; agent decision = "Agent chose …" / "Agent assumed …"; owner decision = "You chose …"; confusion = "You asked why …", detail "Cause: … Fixed: …".

Stored and shown text says "you" for the owner, because v2 is for the owner only. If Arc later becomes a model input, that change adds one preamble line ("you" means the owner).

### Validation and retry

Code repairs what it can and rejects only what it cannot. An answer is **unusable** when no usable Arc remains: the text holds no JSON object, `chapters` is not a list, no new chapter covers the new messages after repair, or a first Build has no cited goal or now. On a later Build, a now with no valid cite is unusable too, except on the last try: Now is the most-read claim, and a retry costs less than a stale Now. Code takes the outermost JSON object from the text, so a code fence or a sentence around it is not a defect.

Every other defect is repaired at its item, and each repair adds a note to the Build record:

- **Citations:** every `Cite.id` must be a Rarebit on this Session's active branch, and every quote must appear in that entry's text (case, whitespace and Markdown emphasis ignored). A failing cite is dropped. A claim keeps its first 3 valid cites; when the first 3 hold no owner cite, the first owner cite replaces the third. A claim with no cite left is dropped.
- **Text:** code never cuts stored text, because a cut can remove the condition that makes a claim true. The word and length rules in the prompt are targets. A label or title over 12 words, or a claim over 600 characters, drops its item. The panel wraps long text.
- **Goal and now:** with no valid cite left, the previous goal stays; the previous now stays only on the last try (see above).
- **Bullets:** children past depth 3 are dropped. A list over its limit (8 roots, 6 children) is truncated.
- **Chapters:** closed chapters are frozen; a changed one is restored. A chapter with an unknown start or no label is dropped. A chapter out of entry order is dropped. Code owns one boundary: the first new chapter starts at the open chapter's start, else at the first uncovered Rarebit. Code moves only that chapter, and the note names the old and new start; its summary can then describe less than its span. A later chapter must start after that boundary. Every chapter except the last is closed. Closed chapters alone never cover new messages: with no new chapter, a window with new messages is unusable, and a Build without new messages keeps the previous open chapter.
- **Key points:** any defect in a point drops that point only: an invalid kind, state or actor, a missing `waits` (required for a request that is open, in progress or blocked, and for an open confusion), a duplicate ID, or a state change on a carried point without a cite that supports the new state. A previous point the answer omits stays unchanged, so a dropped edit keeps the complete stored point. A rule or an owner-raised point needs an owner-message cite, or it is dropped. An unknown or mismatched point `id` makes the point new.

- **Kept items:** the receipt's `kept` lists the goal, the now and the point IDs that keep their previous version because a Build could not update them. The panel shows a muted line at each: "May be out of date: a recent Build could not update this." The mark stays until a later Build updates the item; a Rebuild clears all marks.

Two failure classes:
- `model` (no model, model error, timeout, quota): no immediate retry; the retry waits for the backoff.
- `answer` (unusable, or cut off by the output limit): ask again at once with the reasons appended, up to `retries` more calls per window. Then the Build fails with code `answer`. Accepted windows stay as a checkpoint, so the next Build continues from them.

After a failure, with automatic Builds on, code schedules one retry at the backoff time (the cadence does not apply to a retry). The status stays queued with the error until a Build succeeds. `status.nextAt` names a scheduled timer only: code publishes it when it schedules pending work and clears it when the timer fires. With automatic Builds off, nothing is scheduled, no retry time shows, and **Build** retries. Turning automatic Builds off cancels a scheduled retry and drops automatic work that a running Build would start next.

Admission `busy` is separate from model failure. Every Arc call waits up to 60 s for a shared slot. A refusal after that wait stores the eligible checkpoint of accepted windows with its existing Build records, under the same fuller-receipt rule as a failure, and writes no failed Build record. With no checkpoint, the stored receipt stays unchanged. Refused attempts add no calls or usage. The status stays queued as "Waiting for a model slot". The failure count and backoff stay unchanged, and the Build asks again after 1 s (see Triggers).

Other codes: `source` (the Session changed while read, or did not load), `settings` (invalid `ampi_arc`), `internal`.

## Receipt

One private, rebuildable file per Session under the hub's state directory: `<stateDir>/arc/<sha256(sessionRef)>.json`. The derive path that owns other derived files writes it.

```ts
type ArcReceipt = {
  v: 1;                          // Arc v2 receipt format 1
  session: string;               // Host-qualified Session ref
  asOf: string;                  // last Rarebit entry ID covered
  asOfCount: number;             // Rarebit count covered; staleness = current count − asOfCount
  fingerprint: string;           // Rarebit fingerprint covered; a mismatch at equal count = branch changed
  builtAt: string;
  model: string;                 // exact provider/modelId that answered
  promptVersion: string;         // hash of the prompt and answer shape
  tier: "b";                     // Rarebit tier read
  selector: string;              // Rarebit selector version; a mismatch marks the receipt stale (next Build is a full rebuild)
  goal: Claim; now: Claim;
  chapters: Chapter[];           // oldest first
  points: Point[];
  nextPointId: number;            // next K number; survives empty Builds and Rebuilds
  builds: BuildRecord[];         // newest 30
  kept?: string[];               // "goal", "now" and point IDs a Build could not update, until updated
};
type Chapter = AnswerChapter & {
  n: number; firstAt: string; lastId: string; lastAt: string;
  tokens: number; cost: number;  // exact sums of the chapter's assistant entries' usage
};
type Point = AnswerPoint & { id: string; chapter: number; firstAt: string; stateAt: string; needsYou: boolean };
type BuildRecord = { trigger: "stop" | "owner" | "manual" | "rebuild"; startedAt: string; endedAt: string;
  state: "done" | "failed"; calls: number; windows: number; model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null };
  repairs: string[]; newChapters?: number[]; error?: { code: "model" | "answer" | "source" | "settings" | "internal" | "busy"; message: string } };
```

A receipt with another `promptVersion` stays readable; the next Build is incremental on it. No migration code exists for v1 files: the hub deletes `<stateDir>/cos.arc/` once at start.

**Head for Overview:** the receipt's Needs-you count and oldest Needs-you age feed `ThreadSummary.arc = { needsYou: number; oldestAt?: string; stale: number }` from an in-memory cache filled at hub start by reading every receipt file once (a few KB each), and updated on each write. Overview's Needs you shows "Arc: N need you". No prose leaves the receipt into fleet lists.

## View: the Arc panel

The Arc panel in the Session's right panel area is the only Arc surface. The Arcs page, the Arc list and every Arc link elsewhere are deleted.

Topic: `{ kind: "view", view: "arc", threadId }` → `ArcValue = { receipt?: ArcReceipt; sourceCount?: number; stale: number; branchChanged: boolean; status: { state: "idle" | "queued" | "building" | "failed"; nextAt?: string; progress?: string; work?: ArcWork; error?: BuildRecord["error"] }; series?: UsageSeries }`, with `ArcWork = { from; to; total; part; parts; attempt; attempts; reason?; startedAt }`: the Rarebit positions the current window reads, its part of the estimated parts, its answer try, and why the previous try was rejected. `parts` is an estimate from the bounded size of the later messages and never falls below `part`. `progress` keeps the same facts as text for older clients. `sourceCount` comes from the Session adapter. It is present only when the receipt uses the current selector and tier; older nodes can omit it. The panel never computes a total from `stale`, which can also flag a selection mismatch. `series` is the same 15-minute usage series the Timeline view derives for this Session (tokens and dollars per bucket); the panel never recomputes it. Ops: `view.arc.build { threadId, rebuild? }`.

Layout, top to bottom (from the accepted prototype):

1. **Status line:** "Arc · built 22:52 · covers to 22:43 · 3 newer messages" and the **Build** button (menu: Rebuild). While building: one muted italic line names the whole job, "Building messages 641–1,076 · part 2 of 3 · 1:12". It adds "· try 2 of 3" only after a rejected answer, and the rejection reason shows on hover only. The elapsed time ticks outside the status region, so a screen reader does not announce it every second. A panel that gets only `progress` text shows that text. On failure: the error line beside the last good Arc. If it covers only a prefix, the status says "Covers 640 of 1,076 messages" through failure, queued retry and building. After failure it says "Saved 22:52 (partial)", and the error says "Build failed: reason · next try 22:57" when a retry time exists; the queued line then stays hidden, so the time shows once. Without a failure, a queued Build shows "Queued · starts 22:57". An admission refusal shows "Waiting for a model slot" without a red failure. Build continues from that coverage cursor. A later success clears the error without duplicating chapters or points.
2. **Now · chapter N:** open chapter label; run line from live Session state (working / stopped since …); `now` text; **Needs you** (blockers and confirm items first, oldest first within a group); the goal. A partial Arc reads like a complete one: it is the latest status code has. Only the status line says what it covers ("Covers 640 of 1,076 messages").
3. **Chapters:**
   - Header "Chapters (N)" with a segmented control **Tokens | $** (AmPi `.seg`, like Full | Chat) and **Expand all / Collapse all**.
   - Timeline: row labels in a left gutter (Chapter, Tokens / 15 min or $ / 15 min, Time); usage stream; chapter ranges as zebra bands (alternating two soft shades, no split lines); dashed time ticks at 12 AM, 6 AM, 12 PM, 6 PM local, with the date under 12 AM; hint text gray italic.
   - Hover on a band or a chapter row tints that band and bolds its number; a click on a row opens or closes the chapter and flashes its band once; a click on a band opens its chapter in the list. Open state does not colour bands.
   - List, newest first: number, label, then right-aligned **in fixed columns** start → end, tokens, dollars, with tabular figures, so every row's columns align vertically. An open row shows the chapter summary: scope line, then nested bullets, each with citations; then "Show its N key points" when the chapter has key points.
4. **Key points:** boards by kind (Requests, Decisions, Rules, Confusions), columns by state, scope = all chapters or one chapter. Counts in tabs, links and boards use the same scope.

**Panel width.** The panel defaults to 380 px and can widen to 720 px. Below 560 px: a chapter row takes two lines (number and label; then start → end, tokens, dollars in the same fixed right-aligned columns on every row); a board becomes one list per kind with a heading per state; nothing scrolls sideways at 320 px. Timeline bands have a minimum width of 8 px when space permits; denser timelines divide the available width among all chapters. Every band stays hoverable and clickable. A chapter number appears only on a band at least 14 px wide; hover names every chapter. Time labels that collide with a neighbour are hidden. A new receipt keeps the panel's scroll position and open chapters, and shows "Updated 22:53" once in the status line without moving rows.

Citations show as short gray IDs; hover shows the message with the quote highlighted; click jumps to the entry in the Session (existing citation route helpers). Light and dark themes use AmPi tokens. No colored badges; only Needs you keeps one thin side bar.

## Performance budgets

- Panel switch: render from the cached receipt in under 50 ms p95 for a 15-chapter, 60-point Arc; no full-Session parse, no Rarebit read, no model call on read.
- Store step: under 50 ms for that Arc. The persisted `timing.storeMs` measures merge and serialization; the final disk write is excluded.
- Incremental Build on Haiku: under 30 s wall time and under $0.02 for a typical stop (≤ 20k input tokens).
- First Build of a 110k-token Session: at most 3 windows; cost shown in the Build record. The target wall time is under 3 minutes; the measured time below does not meet it.

  Measured status: real Haiku first Builds through the magpie bridge take 334–457 s, and the incremental budget is unverified. The owner accepts this time for now. The cause lies outside Arc, in the model config and the bridge. The follow-up is deferred in [now.md](../../../docs/current/now.md#deferred).
- Trigger overhead: a Rarebit append costs one in-memory check; no disk read.
- Memory: the hub keeps heads for every Session and full receipts only for Sessions with a subscribed panel, at most `RECEIPT_CACHE` (32) by least recent use. Build evidence is released when the Build ends.
- Measurement before release: per Build, record queue wait, evidence read, model time and store time separately, with billed usage per call including failed calls; run 1, 5 and 20 live synthetic Sessions with stop and owner bursts plus a concurrent non-Arc helper call, and record event-to-receipt age, calls per hour and dollars per hour.

## Tests

- Offline model fixture (`askCommand`) answers by window; tests cover: first Build in windows, incremental Build, closed-chapter freeze and repair, point ID carry-over, cite and quote checks, depth and limit checks, `answer` retry up to `retries` + 1 calls, item repairs, `model` backoff, debounce and pending flag, concurrency limit, settings parsing (default, valid, invalid), staleness and branch change, Overview head.
- Durable Session: one Build through the same path.
- Panel: browser test for layout, sync rules (hover tint, row-click flash, band click opens), segmented control, aligned columns, narrow width, themes.
- Performance: a synthetic 15-chapter Arc render and store timing; a real-shape Build measured once against Haiku and recorded in the change description.
