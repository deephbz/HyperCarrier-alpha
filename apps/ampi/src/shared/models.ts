// Model choice types for the wire contract.
// The node model registry produces these values; hub and web consumers read them.
export type ModelChoice = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	available: boolean;
	/** The model new threads on this host start with. */
	default?: true;
};
