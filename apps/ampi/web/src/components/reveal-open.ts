import { createContext, useContext, useEffect, useState } from "react";

/**
 * The reveal scope of a transcript (ThreadView). A newer reveal leaves the bodies and folds of earlier reveals open; a
 * Transcript-mode toggle starts a new scope, which closes everything a reveal opened and keeps what the reader opened.
 */
export const RevealScope = createContext(0);

type Held = { open?: boolean; byReveal: boolean; scope: number };

/**
 * The open state of a tool body or fold that a reveal can open: each new `reveal` request opens it. Undefined means the
 * owner's default. The setter records the reader's choice; it is a no-op when the state does not change.
 */
export function useRevealOpen(reveal: number | undefined): [boolean | undefined, (open: boolean) => void] {
	const scope = useContext(RevealScope);
	const [held, setHeld] = useState<Held>(() => ({ open: reveal ? true : undefined, byReveal: Boolean(reveal), scope }));
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => { if (reveal) setHeld({ open: true, byReveal: true, scope }); }, [reveal]);
	const open = held.byReveal && held.scope !== scope ? undefined : held.open;
	return [open, (next) => { if (next !== open) setHeld({ open: next, byReveal: false, scope }); }];
}
