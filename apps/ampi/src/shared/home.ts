// The AmPi home root, read from the environment at call time.
import { homedir } from "node:os";
import { join } from "node:path";

export function ampiHome(): string {
	return process.env.AMPI_HOME ?? join(homedir(), ".ampi");
}
