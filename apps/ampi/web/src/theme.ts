// The owner's theme choice and the one effective theme every reader uses.
// index.html applies the stored choice before first paint; this module keeps it current after that.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** localStorage key; index.html's inline script reads the same key. */
export const THEME_KEY = "ampi.theme";
const CHANGE = "ampi:theme";
const system = () => matchMedia("(prefers-color-scheme: dark)");

export function themeChoice(): ThemeChoice {
	const v = localStorage.getItem(THEME_KEY);
	return v === "light" || v === "dark" ? v : "system";
}

/** Stores the choice and sets `data-theme` on <html>; "system" removes it, so the OS media query decides. */
export function setThemeChoice(choice: ThemeChoice) {
	if (choice === "system") {
		localStorage.removeItem(THEME_KEY);
		delete document.documentElement.dataset.theme;
	} else {
		localStorage.setItem(THEME_KEY, choice);
		document.documentElement.dataset.theme = choice;
	}
	window.dispatchEvent(new Event(CHANGE));
}

export function effectiveTheme(): Theme {
	const choice = themeChoice();
	return choice === "system" ? (system().matches ? "dark" : "light") : choice;
}

function subscribe(onChange: () => void) {
	const media = system();
	media.addEventListener("change", onChange);
	window.addEventListener(CHANGE, onChange);
	// Another tab changed the choice.
	const storage = (e: StorageEvent) => {
		if (e.key !== THEME_KEY) return;
		const choice = themeChoice();
		if (choice === "system") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = choice;
		onChange();
	};
	window.addEventListener("storage", storage);
	return () => {
		media.removeEventListener("change", onChange);
		window.removeEventListener(CHANGE, onChange);
		window.removeEventListener("storage", storage);
	};
}

/** The stored choice; re-renders when it changes. */
export const useThemeChoice = () => useSyncExternalStore(subscribe, themeChoice);
/** The theme in effect; re-renders on a toggle, another tab, or an OS change under "system". */
export const useTheme = () => useSyncExternalStore(subscribe, effectiveTheme);
