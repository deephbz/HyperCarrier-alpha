// Child for the durable-hardening single-owner test: it owns the cache directory in argv[2] until it is killed.
import { DurableViews } from "../../src/durable/reader-side.ts";

new DurableViews({ host: "demo", cacheDir: process.argv[2]!, node: () => { throw new Error("This holder reads no node"); } });
process.stdout.write("held\n");
setInterval(() => {}, 1 << 30);
