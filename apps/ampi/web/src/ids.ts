/**
 * The web app's one id minter. The browser's own UUID minter exists only in a secure context, and a hub served
 * over http from a LAN address is not one. `crypto.getRandomValues` exists in every context. The id is an RFC 4122
 * version 4 UUID, the form the hub requires of a request key.
 */
export function newId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
