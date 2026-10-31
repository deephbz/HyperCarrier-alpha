// A script's output reaches its reader before the script exits. On POSIX, Node writes stdout and stderr to a pipe or a
// socket asynchronously, and process.exit drops the bytes the kernel has not taken yet. A slow reader, or the 4 KiB pipe
// that Linux gives a user over fs.pipe-user-pages-soft, then loses the tail: under gate load on 2026-10-31,
// `run-tests.cjs --list` printed only part of its list. Blocking writes keep every byte. A script that calls process.exit
// loads this module before its first write (test/run-tests.test.ts).
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
