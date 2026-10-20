// Step 1 of a Build: labels per chunk. It asks the label model in batches and returns what it got; it never writes.
// The orchestrator (cos-arc.ts) decides what a partial result means and persists only complete Builds.
import type { Chunk } from "./cos-arc-chunks.ts";
import { fields, normalizeLabel, type Label } from "./cos-arc-format.ts";
import { LABEL_SYSTEM, labelPrompt } from "./cos-arc-prompts.ts";
import { InvalidReply, errorCode, failure, type Call } from "./cos-arc-reply.ts";

/** Chunks one label call covers. */
export const LABEL_BATCH = 6;
export type StoredLabel = Label & { hash: string };
/** `missed`: chunks without a label after the retry; `error`: the first failure behind them; `model`: the last answering model. */
export type Step1Result = { labels: Record<string, StoredLabel>; missed: Chunk[]; error: Error | null; model: string | null };

/** One label call for `batch`: the labels it returned and the chunks it missed. A failed call misses them all. */
type Labelled = { model: string | null; labels: [string, StoredLabel][]; missed: Chunk[]; error: Error | null };

/**
 * Labels `fresh` chunks in batches of LABEL_BATCH, at most `limit` calls in flight. A batch repeats once for only its
 * missed chunks; chunks still missed come back in `missed`. An invalid reply was already asked twice by `call`, so it
 * does not repeat. `retried` and `settled` report progress; labels keep chunk order whatever the completion order.
 */
export async function labelChunks(fresh: Chunk[], evidence: Map<string, string>, { call, req, limit, bounded, retried, settled }: {
	call: Call; req: { purpose: "arcLabels"; model: string; resolved: true }; limit: number;
	bounded: <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => Promise<R[]>;
	retried: () => void; settled: (chunks: number) => void;
}): Promise<Step1Result> {
	const batches = Array.from({ length: Math.ceil(fresh.length / LABEL_BATCH) }, (_, i) => fresh.slice(i * LABEL_BATCH, (i + 1) * LABEL_BATCH));
	const label = async (batch: Chunk[]): Promise<Labelled> => {
		let model: string | null, raw: { chunks: unknown[] };
		try { const r = await call<{ chunks: unknown[] }>("label", { system: LABEL_SYSTEM, prompt: labelPrompt(batch, evidence), ...req }); raw = r.reply; model = r.answer.model ?? null; }
		catch (e) { return { model: e instanceof InvalidReply ? e.model : null, labels: [], missed: batch, error: e as Error }; }
		// The model answered: whatever is wrong with the answer is an `answer` failure.
		try {
			const out: [string, StoredLabel][] = [], missed: Chunk[] = [];
			for (const c of batch) {
				const l = normalizeLabel(raw.chunks.find((x) => fields(x).chunk === c.id), evidence.get(c.id) ?? "");
				if (l.project && l.topic) out.push([c.id, { hash: c.hash, ...l }]); else missed.push(c);
			}
			return { model, labels: out, missed, error: missed.length ? failure("answer", `The model omitted labels for ${missed.map((c) => c.id).join(", ")}.`) : null };
		} catch (e) {
			return { model, labels: [], missed: batch, error: errorCode(e) === "answer" ? e as Error : failure("answer", `The model’s label answer was unusable: ${(e as Error).message}`) };
		}
	};
	const answers = await bounded(batches, limit, async (batch) => {
		let a = await label(batch);
		if (a.missed.length && !(a.error instanceof InvalidReply)) {
			retried();
			const again = await label(a.missed);
			a = { model: again.model ?? a.model, labels: [...a.labels, ...again.labels], missed: again.missed, error: again.error };
		}
		settled(batch.length);
		return a;
	});
	const got = new Map(answers.flatMap((a) => a.labels)), labels: Record<string, StoredLabel> = {};
	for (const c of fresh) { const l = got.get(c.id); if (l) labels[c.id] = l; }
	return { labels, missed: answers.flatMap((a) => a.missed), error: answers.find((a) => a.error)?.error ?? null, model: answers.reduce<string | null>((m, a) => a.model ?? m, null) };
}
