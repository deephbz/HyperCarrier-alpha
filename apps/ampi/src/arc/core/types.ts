import type { ArcReceipt, BuildRecord, WaitFacts, BuildStatus, RequestResult, DismissResult } from "../../shared/arc.ts";

// The source adapter owns selection and entry order. The core never reads a carrier store.
export type ArcItem = { id: string; kind: "user" | "continuation" | "stop" | "error" | "compaction"; owner: boolean; t: string | null; text: string; truncated?: boolean };
export type ArcEntry = { id: string; at: string; tokens: number; cost: number };
export type ArcSource = { session: string; selector: string; fingerprint: string; items: ArcItem[]; entries: ArcEntry[] };
export type SourceSnapshot = ArcSource & { sourceVersion: string };
export type SourceCheck = { kind: "same-prefix" } | { kind: "history-changed"; sourceVersion: string; reason: string } | { kind: "unavailable"; reason: string };
export interface SourcePort {
 snapshot(sessionRef: string): Promise<SourceSnapshot>;
 // Only authoritative evidence may report history-changed. Appends preserve a prefix.
 check(snapshot: SourceSnapshot): Promise<SourceCheck>;
}
export type ModelInput = { system: string; prompt: string; model: string; resolved: true; timeoutMs: number; maxOutputTokens: number; onWait?: (waiting: boolean) => void };
export type ModelAnswer = { text: string; model?: string; usage?: BuildRecord["usage"]; truncated?: boolean };
// failed proves a known outcome. Omitted usage means zero cost before dispatch.
// An adapter that cannot prove the charge returns measured-unknown instead.
export type ModelFailure = { kind: "failed"; code: "settings" | "sign-in" | "model" | "quota"; message: string; prerequisite?: "pi" | "pi-auth-check"; authPath?: string; settingsPath?: string; settingsKey?: string; usage?: BuildRecord["usage"]; retryAt?: string };
export type ModelResult = { kind: "answer"; answer: ModelAnswer } | { kind: "measured-unknown"; reason: string; code?: "model-mismatch"; usage?: BuildRecord["usage"] } | ModelFailure;
export type BuildKind = "incremental" | "manual" | "rebuild";
export type Permit = { id: string };
export interface Admission {
 acquire(kind: BuildKind): Promise<{ kind: "permit"; permit: Permit } | { kind: "wait"; facts: WaitFacts }>;
 // Release is idempotent by permit ID. The adapter restores outstanding permits from Store before run.
 // uncertain retains local capacity until verified process exit. It does not mean
 // unknown billing: an answered call can still have a live child.
 release(permit: Permit, outcome: "settled" | "uncertain"): Promise<void>;
}
export type ExecutionIdentity = { pid: number; startedAt: string };
export type CallContext = { callId: string; started(identity: ExecutionIdentity): void; exited(): void };
export interface ModelPort {
 // Spawn with stdin blocked. Call context.started and wait for its durable return before writing the prompt.
 // If started throws, kill the unadmitted child. A PID alone does not prove process identity.
 call(input: ModelInput, exactModel: string, permit: Permit, context: CallContext): Promise<ModelResult>;
 // The core polls unresolved executions on every run, including paused Sessions.
 // Report running when identity or exit cannot be verified.
 reconcile(identity: ExecutionIdentity): Promise<"running" | "gone">;
}
export type BuildSettings = { model: string; retries: number; windowTokens?: number };
export type CallRecord = { id: string; input: ModelInput; permit: Permit; state: "intent" | "answered" | "uncertain" | "failed"; failure?: ModelFailure; ms?: number; execution?: ExecutionIdentity; executionState?: "running" | "gone"; answer?: ModelAnswer; reason?: string; uncertaintyCode?: "model-mismatch"; usage?: BuildRecord["usage"] };
export type BuildJob = {
 buildId: string; sessionRef: string; kind: BuildKind; requester: string; settings: BuildSettings; engineVersion: string;
 state: "queued" | "running" | "done" | "uncertain" | "failed" | "obsolete";
 record: BuildRecord; snapshot?: SourceSnapshot; checkpoint?: ArcReceipt; complete?: boolean;
 calls: CallRecord[]; callHistory: CallRecord[]; reason?: string; elapsedMs?: number; nextAt?: string;
};
export type RequestOptions = { trigger?: "stop" | "owner"; nextAt?: string };
export type BuilderCommand = Omit<Extract<AcceptedCommand, { kind: BuildKind }>, "buildId"> | Omit<Extract<AcceptedCommand, { kind: "dismiss" }>, "revision">;
export type AcceptedCommand = { requestId: string; sessionRef: string; kind: BuildKind; requester: string; buildId: string; options?: RequestOptions } | { requestId: string; sessionRef: string; kind: "dismiss"; dropId: string; toPosition: number; revision: number };
export type ReceiptRevision = { revision: number; sessionRef: string; receipt: ArcReceipt };
export type SessionState = { failures?: number; active?: string; pending?: string; status?: BuildStatus; completedTarget?: { sourceVersion: string; buildId: string }; receipt?: ReceiptRevision };
export type BuilderState = { schema: 1; revision: number; commands: Record<string, AcceptedCommand>; jobs: Record<string, BuildJob>; sessions: Record<string, SessionState> };
// One exclusively owned Store per Builder. save must atomically replace and durably flush before return.
// The service owns process exclusion. A failed save stops execution; it never acknowledges acceptance.
export interface Store { load(): BuilderState | undefined; save(state: BuilderState): void }
export interface Builder {
 // Query durable command knowledge without admitting work. Undefined means no accepted ID.
 replay(command: BuilderCommand): RequestResult | DismissResult | undefined;
 request(sessionRef: string, requestId: string, kind: BuildKind, requester: string, options?: RequestOptions): Promise<RequestResult>;
 dismiss(sessionRef: string, requestId: string, dropId: string, toPosition: number): DismissResult;
 receipts(knownRevisions?: Record<string, number>): ReceiptRevision[];
 status(): BuildStatus[];
 // Run accepted work, or retry admission after a wait. There is no timer or transport in the core.
 run(sessionRef?: string): Promise<void>;
}
