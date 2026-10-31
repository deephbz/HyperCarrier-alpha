// ESM modules the remote agent imports. The agent runs from stdin with no files beside it, so each module travels
// in the agent's config as one self-contained `data:` URL, with its relative imports inlined the same way.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SPECIFIER = /\b(from|import)(\s*\(?\s*)(["'])([^"']+)\3/g;

/** `url`'s module as a `data:` URL. Bare imports cannot resolve inside a `data:` module, so they throw here. */
export function inlineModule(url: string): string {
	const source = readFileSync(fileURLToPath(url), "utf8").replace(SPECIFIER, (_, keyword: string, gap: string, _quote: string, specifier: string) => {
		if (!/^\.\.?\//.test(specifier)) throw new Error(`${url}: the remote agent cannot import ${specifier}`);
		return `${keyword}${gap}${JSON.stringify(inlineModule(new URL(specifier, url).href))}`;
	});
	return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

/** The agent config entries that carry its modules (remote-agent.cjs `cfg.autoCompactResolve`). */
export function agentModules(): { autoCompactResolve: string } {
	return { autoCompactResolve: inlineModule(import.meta.resolve("@hypercarrier/hc-auto-compact/resolve")) };
}
