// Newline-delimited JSON framing for byte streams (unix sockets, SSH stdio).

import { StringDecoder } from "node:string_decoder";

/** The longest frame either side accepts; a peer that sends more without a newline is broken or hostile. */
export const MAX_LINE = 64 * 1024 * 1024;

export function lineReader(onLine: (line: string) => void, onOverflow: () => void = () => {}): (chunk: Buffer | string) => void {
	let buffer = "";
	// A multibyte character can straddle two chunks (SSH and socket reads split anywhere); the decoder carries the
	// partial bytes over instead of turning them into U+FFFD.
	const decoder = new StringDecoder("utf8");
	return (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim() !== "") onLine(line);
			index = buffer.indexOf("\n");
		}
		if (buffer.length > MAX_LINE) {
			buffer = "";
			onOverflow();
		}
	};
}

export function encodeFrame(frame: unknown): string {
	return `${JSON.stringify(frame)}\n`;
}
