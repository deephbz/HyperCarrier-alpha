// Step 2 of a Build: one arcSynthesis call reads every labelled chunk with its Rarebit messages and ask candidates,
// and writes tier 1 (headline, projects, transitions) and tier 2 (the evergreen tree) together. It never writes; the
// orchestrator (cos-arc.ts) persists the result.
import type { Chunk } from "./cos-arc-chunks.ts";
import { emptyTree, normalizeContext, rawTreeCount, treeCount, type ArcContext, type ContextSupport, type TreeCount } from "./cos-arc-context.ts";
import { normalizeTier1, type Label, type Tier1 } from "./cos-arc-format.ts";
import { STEP2_SYSTEM, step2Prompt } from "./cos-arc-prompts.ts";
import { InvalidReply, type Call, type SynthesisReply } from "./cos-arc-reply.ts";

/** The owner-facing failure of a step-2 answer whose tree kept nothing, even after its retry. */
export const EMPTY_ANSWER = "The model returned an empty Arc, even after one retry.";
/** An empty tree below the floor: the Build ends done with nothing to summarize. It is no invalid reply, so no retry. */
export class NothingYet extends Error {}

/** What step 2 reads: the Build's snapshot, with the tree's citation inputs. */
export type Step2Input = { chunks: Chunk[]; labels: Record<string, Label & { hash?: string }>; evidence: Map<string, string>; support: ContextSupport; cwd: string;
	ref: string; times: Map<string, number | null>; rarebitCount: number; fingerprint: string; asOfEntryId: string | null;
	/** True below the automatic floor (arcFloor), where an empty tree is expected. */
	belowFloor: boolean;
	/** `labels`: the prompt shows each chunk's owner turns only; citations still check against the full evidence. */
	evidenceMode?: "full" | "labels" };
/** `tree`: the last answer's counts as the model wrote them, and as kept after the citation filter. */
export type Step2Result = { tier1: Tier1; context: Omit<ArcContext, "builtAt" | "model">; model: string | null };

/**
 * Writes both tiers in one call. An answer whose tree keeps nothing is invalid at or above the floor, so `call` asks
 * once more; below the floor it ends the Build quietly (NothingYet). `counted` sees every answer's tree counts.
 */
export async function writeArc(input: Step2Input, { call, req, counted }: {
	call: Call; req: { purpose: "arcSynthesis"; model: string; resolved: true }; counted: (c: { raw: TreeCount; kept: TreeCount }) => void;
}): Promise<Step2Result> {
	const { chunks, labels, evidence, support } = input;
	const ids = new Set(chunks.map((c) => c.id));
	// Labels go to the model without their hash or cut-text keeps.
	const shown = Object.fromEntries(Object.entries(labels).map(([id, { full: _f, hash: _h, ...l }]) => [id, l]));
	const accept = (raw: SynthesisReply) => {
		const tree = normalizeContext(raw, chunks, evidence, input.ref, input.times, "", null, input.rarebitCount, input.fingerprint, input.asOfEntryId, support);
		counted({ raw: rawTreeCount(raw), kept: treeCount(tree) });
		if (emptyTree(tree) && input.belowFloor) throw new NothingYet();
		if (emptyTree(tree)) throw new InvalidReply("synthesis", "no work thread, open ask or unassigned item with a citation and a verbatim quote from the evidence", EMPTY_ANSWER);
		const { builtAt: _b, model: _m, ...context } = tree;
		return { tier1: normalizeTier1(raw, ids), context };
	};
	const { answer, reply } = await call<SynthesisReply, ReturnType<typeof accept>>("synthesis", { system: STEP2_SYSTEM, prompt: step2Prompt(chunks, shown, evidence, support, input.cwd, input.evidenceMode), ...req }, accept);
	return { ...reply, model: answer.model ?? null };
}
