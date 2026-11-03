// SSH transport policy of the Pi Host links.
export function sshOptions(compress = false): string[] {
	return ["-T", ...(compress ? ["-C"] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
}

export function reconnectDelay(attempts: number): number {
	return Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
}
