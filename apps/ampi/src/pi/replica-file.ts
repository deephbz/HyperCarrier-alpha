// A replica resumes after its last complete JSONL line. Repair an interrupted append without reading its history.
import { open } from "node:fs/promises";

export async function repairReplicaTail(file: string): Promise<number> {
	const handle = await open(file, "r+");
	try {
		const { size } = await handle.stat();
		let cursor = size;
		const buffer = Buffer.alloc(64 * 1024);
		while (cursor > 0) {
			const start = Math.max(0, cursor - buffer.length);
			const { bytesRead } = await handle.read(buffer, 0, cursor - start, start);
			const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
			if (newline >= 0) {
				const end = start + newline + 1;
				if (end !== size) await handle.truncate(end);
				return end;
			}
			cursor = start;
		}
		if (size) await handle.truncate(0);
		return 0;
	} finally {
		await handle.close();
	}
}
