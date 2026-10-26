// System Prompt Audit for a durable thread. The node reconstructs the effective prompt and serves
// the renderer's snapshot (schemaVersion 1) through `audit.snapshot`; the hub only validates and
// renders it. The hub never rebuilds a prompt from pi.system deltas.
// @ts-ignore: the audit package is plain ESM without types.
import { renderSystemPromptReviewHtml, renderSystemPromptReviewMarkdown, validateSystemPromptSnapshot } from "@hypercarrier/systemp-prompt-audit/system-prompt-review.mjs";

export type AuditSnapshot = {
 schemaVersion: 1;
 capturedAt: string;
 cwd: string;
 systemPrompt: string;
 activeTools: Array<{ name: string } & Record<string, unknown>>;
 provenance?: unknown;
 integrity: { contentSha256: string };
};
export type AuditReview = { source: string; snapshot: AuditSnapshot; markdown: string; html: string };
/** One request to the node. */
export type NodeCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

/** Fetch the node's snapshot for a thread (at an entry when given) and render both review forms. */
export async function durableAuditReview(call: NodeCall, host: string, at: { threadId: string; entryId?: string }): Promise<AuditReview> {
 const args: Record<string, unknown> = { threadId: at.threadId };
 if (at.entryId) args.entryId = at.entryId;
 const snapshot = validateSystemPromptSnapshot(await call("audit.snapshot", args)) as AuditSnapshot;
 const source = `${host}/pi-durable:${at.threadId}${at.entryId ? `#${at.entryId}` : ""}`;
 return { source, snapshot, markdown: renderSystemPromptReviewMarkdown(snapshot, source), html: renderSystemPromptReviewHtml(snapshot, source) };
}
