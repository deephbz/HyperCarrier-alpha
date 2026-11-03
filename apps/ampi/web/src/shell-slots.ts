// The App shell's UI slots: what a Host kind draws in the sidebar and New agent, and the shell-wide layers, steps and
// actions another line registers in extensions-ui.ts. Components read them here; host-kinds.ts keeps the pure facts.

import type { ComponentType, ReactNode } from "react";
import { findHost, useHosts, type HostState } from "./client.ts";
import type { ActionAck, CommandAck, InjectedMessage, PiEntry, PiQueuedItem, PiThreadView, ThreadSummary } from "../../src/shared/protocol.ts";
import type { Outcome } from "./composer-drafts.ts";
import type { HintState } from "./composer-keys.ts";
import type { TeamValue } from "../../src/shared/team.ts";
import type { HostThreads } from "./components/Sidebar.tsx";
import type { PanelView } from "./views/registry.ts";
import { kindUis } from "./extensions-ui.ts";
import { hostKind, kindOfLink } from "./host-kinds.ts";

/**
 * One kind's New agent form, below the Host select. `host` is the chosen link key, empty when no Host is listed;
 * `beside` is the open thread when it is on this Host.
 */
export type NewFormProps = { host: string; hosts: HostState[]; beside?: ThreadSummary; onClose: () => void };

/** A Host kind's UI. Every field is optional: an absent one keeps the Pi shape (PiSidebar.tsx, PiDialogs.tsx). */
export interface HostKindUi {
	sidebar?: {
		/** Notes under the Host's header while it is unfolded. */
		Notes?: ComponentType<{ host: HostState }>;
		/** The rows the section lists; a hook, so it can read a shared filter. */
		useRows?: (threads: ThreadSummary[]) => ThreadSummary[];
		/** The layout pane a row sits in (sidebar-layout.ts); undefined lists it as unplaced. */
		paneOf?: (thread: ThreadSummary) => string | undefined;
		unplacedLabel?: string;
		readingNote?: string;
		emptyNote?: string;
	};
	NewForm?: ComponentType<NewFormProps>;
	thread?: ThreadSurface;
}

type EntryPlace = { host: string; threadId: string };
/** A user message's action, after its time. `closed`: the thread is closed. */
export type EntryActionProps = EntryPlace & { entry: string; closed: boolean };
export type UserImagesProps = EntryPlace & { entryId: string; count: number };
/** `compactions` counts the compaction rows in the list; `more` is the clipped summary's reader (EntryBody). */
export type CompactionRowProps = EntryPlace & { entry: Extract<PiEntry, { kind: "compaction" }>; fragment: string; compactions: number; more: ReactNode };
/** `close` opens the kind's close dialog (ThreadSurface.closeDialog). */
export type ThreadHeaderProps = EntryPlace & { summary?: ThreadSummary; hostState?: HostState; close: () => void };
export type CloseDialogProps = { host: string; summary: ThreadSummary; onClose: () => void };

/**
 * What a Host kind draws in and beside a thread (ThreadView.tsx, PiPanel.tsx). Every field is optional: an absent one
 * keeps the Pi shape.
 */
export interface ThreadSurface {
	/** Replaces the user row's Rarebit jump; assistant rows then show no jump. */
	entryAction?: ComponentType<EntryActionProps>;
	/** Default: the image count as a hint. */
	userImages?: ComponentType<UserImagesProps>;
	/** Default: the compaction line and its summary disclosure. */
	compactionRow?: ComponentType<CompactionRowProps>;
	/** The URL of an extension message's raw export, linked in its card. */
	rawExport?: (entry: Extract<PiEntry, { kind: "custom" }>) => string | undefined;
	/** A kind supplies the notice text for an entry that carries none. */
	noticeMessage?: (entry: Extract<PiEntry, { kind: "custom" }>) => InjectedMessage;
	/** Drawn in the header after the status badges. */
	header?: ComponentType<ThreadHeaderProps>;
	/** More menu items while the thread is live. */
	menuItems?: ComponentType<ThreadHeaderProps>;
	/** Default: CloseAgentDialog (Herdr closes the pane). */
	closeDialog?: ComponentType<CloseDialogProps>;
	/** Set: the title field is editable and a blur saves it. */
	rename?: (host: string, threadId: string, title: string) => void;
	/** Set: a model sign-in error offers a Fix sign-in button. */
	signIn?: (host: string) => void;
	/** Default: the thread has a control extension. */
	canQuote?: (summary: ThreadSummary | undefined) => boolean;
	/** Panels after the Pi panels. */
	panels?: PanelView[];
	composer?: ComposerSurface;
}

/** `disabled`: listed but not runnable from here. A command without `run` goes to the Host as a typed op. */
export type LocalCommand = { name: string; args?: string; help: string; disabled?: boolean; run?: (arg: string) => Promise<void> | void };
/**
 * What a composer slot may do to its thread's composer. `draftKey` names the draft custody the api writes, so a late
 * answer still lands in its own thread's draft. `fail` shows a request error with the draft kept.
 */
export type ComposerApi = {
	draftKey: string;
	say: (text: string) => void;
	fail: (error: Error & { code?: string }) => void;
	/** Puts text ahead of the draft; it has no retry identity. */
	prependDraft: (text: string) => void;
	/** Adds text after the draft; `outcome` stays with it as a notice until the text leaves the draft. */
	appendDraft: (text: string, outcome?: Outcome) => void;
	focus: () => void;
	panel?: string;
	openPanel?: (name: string) => void;
};
export type ComposerPlace = { host: string; threadId: string; view: PiThreadView; summary?: ThreadSummary };
/** How the composer names a queued message that left the queue without delivery, keyed by its state. */
export type QueueOutcome = { badge: string; tone: string; note: string; recover?: string };
/** `row`: the core row for one item, so a kind's queue keeps the core look for the items it does not own. */
export type QueueProps = ComposerPlace & { items: PiQueuedItem[]; row: (item: PiQueuedItem) => ReactNode; api: ComposerApi };
export type ModelControlProps = ComposerPlace & { closed: boolean; onOpen: () => void };

/**
 * A Host kind's composer slots (Composer.tsx). Every field is optional: an absent one keeps the Pi shape. Visible
 * order: core entries first, then the slot's entries.
 */
export interface ComposerSurface {
	/** Commands that run in this page, listed after the Host's; a supported Host command of the same name wins. */
	localCommands?: (place: ComposerPlace, api: ComposerApi) => LocalCommand[];
	/** Wording. `source`: who serves the command list ("Pi"). `unsupported`: the help of a command the composer cannot run. */
	texts?: { source: string; unsupported: string; refuseUnsupported: (name: string) => string; noImages: string };
	/** The Host places a request key at most once, so an unknown outcome promises a once-only retry. */
	deduplicates?: true;
	/** The Host decides slash text: a bare `/` goes out as a message, and its unknown_command is a refusal. */
	hostDecidesSlash?: true;
	/** The Host takes message text as typed: a message keeps its outer whitespace, and `//` drops only the escape slash. */
	literalText?: true;
	/** Queue outcomes by item state. */
	outcomes?: Record<string, QueueOutcome>;
	/** Replaces the queue block. */
	queue?: ComponentType<QueueProps>;
	/** Set for a summary: the thread is read-only; the node shows below the kept draft, and nothing sends. */
	readOnly?: (summary: ThreadSummary | undefined) => ReactNode | undefined;
	/** Stop's reply; true when the slot said what happened. */
	onAbort?: (ack: ActionAck, api: ComposerApi) => boolean;
	/** A sent message's reply; `before` is the summary at send time. True when the slot said what happened. */
	onSubmitted?: (ack: ActionAck, before: ThreadSummary | undefined, api: ComposerApi) => boolean;
	/** The reply to the latest command sent from this draft. Runs only while this Session is on screen; a late answer acts only through custody. */
	onCommand?: (ack: CommandAck, api: ComposerApi) => void;
	/** Replaces the model HUD card. */
	modelControl?: ComponentType<ModelControlProps>;
	/** Drawn above the composer box. */
	banner?: ComponentType<ComposerPlace>;
	/** The idle composer hint. */
	hint?: (state: HintState) => string;
}

export type AppLayerProps = { feeds: Record<string, HostThreads>; hosts: HostState[] };
export type OverviewStepProps = { data: HostThreads[]; onNew: () => void; onHostSetup: () => void; onHelp: () => void };
export type SidebarFooterProps = { data: HostThreads[] };
export type HelpActionProps = { onClose: () => void };
/** One view of a Team in the Team panel, beside Tasks. */
export type TeamMode = { key: string; label: string; component: ComponentType<{ team: TeamValue["teams"][number]; host: string }> };

const NO_SURFACE: ThreadSurface = {};

/** A Host kind's thread surface; Pi's is empty. */
export function threadSurface(host: Pick<HostState, "kind"> | undefined): ThreadSurface {
	return kindUi(host).thread ?? NO_SURFACE;
}

/** The thread surface of a link key's Host. */
export function useThreadSurface(host: string): ThreadSurface {
	const known = findHost(useHosts().hosts, host);
	// Before the Host list arrives, a link key's source suffix (`devbox#pi`) names the kind.
	const kind = known ? hostKind(known) : kindOfLink(host);
	return (kind && kindUis[kind.source]?.thread) ?? NO_SURFACE;
}

export function kindUi(host: Pick<HostState, "kind"> | undefined): HostKindUi {
	return kindUis[hostKind(host).source] ?? {};
}
