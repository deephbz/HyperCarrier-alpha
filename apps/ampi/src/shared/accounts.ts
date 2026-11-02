// Account view types for the wire contract.
// Node account services produce these values; hub and web account consumers read them.
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

export type ProviderStatus = {
	id: string;
	name: string;
	signedIn: boolean;
	/** Where the working credential comes from (stored key, OAuth, an environment variable), when signed in. */
	source?: string;
	authType?: "api_key" | "oauth";
	methods: { type: AuthType; label: string; subscription?: boolean }[];
	models: number;
};

export type PromptView = { id: string; type: AuthPrompt["type"]; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };

export type LoginState = {
	id: string;
	providerId: string;
	type: AuthType;
	status: "running" | "done" | "error" | "cancelled";
	events: AuthEvent[];
	prompt?: PromptView;
	error?: string;
	/** Set when the credential was saved but the provider could not be reached to confirm it. */
	warning?: string;
};
