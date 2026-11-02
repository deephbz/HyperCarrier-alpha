// The node's error type: a refusal with a wire `code`, which the server sends to clients as is.

export class NodeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}
