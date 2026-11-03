// The service owns this lock for its lifetime. Never unlink service.lock.
// Perl supplies flock on macOS and Linux; exec transfers ownership to Node.
import { spawn, type SpawnOptions } from "node:child_process";
import { fstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOCK_BUSY = 73;
const LAUNCHER = String.raw`
use strict;
use warnings;
use Fcntl qw(:flock :DEFAULT F_GETFD F_SETFD FD_CLOEXEC);
my ($store, $node, @args) = @ARGV;
defined($store) && defined($node) && @args or die "Arc launcher: missing arguments\n";
sysopen(my $lock, "$store/service.lock", O_RDWR | O_CREAT, 0600)
  or die "Arc launcher: open lock: $!\n";
flock($lock, LOCK_EX | LOCK_NB) or exit(73);
my $fd = fileno($lock);
my $flags = fcntl($lock, F_GETFD, 0);
defined($flags) or die "Arc launcher: get fd flags: $!\n";
fcntl($lock, F_SETFD, $flags & ~FD_CLOEXEC)
  or die "Arc launcher: inherit lock: $!\n";
$^F = $fd;
$ENV{AMPI_ARC_LOCK_FD} = "$fd";
$ENV{AMPI_ARC_STORE} = $store;
exec {$node} $node, @args;
die "Arc launcher: exec node: $!\n";
`;

export function launchLocked(store: string, nodeArgs: string[], options: SpawnOptions = {}, node = process.execPath) {
 mkdirSync(store, { recursive: true, mode: 0o700 });
 return spawn("perl", ["-e", LAUNCHER, realpathSync(store), node, ...nodeArgs], options);
}

export interface ServiceLock {
 readonly store: string;
 assertHeld(): void;
}

// A child can only enter the writer through the launcher. Spawn model children
// with explicit stdio; never pass this descriptor in their stdio array.
export function inheritedLock(): ServiceLock {
 const store = process.env.AMPI_ARC_STORE;
 const fd = Number(process.env.AMPI_ARC_LOCK_FD);
 if (!store || !Number.isInteger(fd) || fd < 3) throw new Error("Arc service requires the lifetime lock");
 const expected = fstatSync(fd);
 const assertHeld = () => {
  const open = fstatSync(fd), named = statSync(join(store, "service.lock"));
  if (!open.isFile() || open.dev !== expected.dev || open.ino !== expected.ino ||
      named.dev !== open.dev || named.ino !== open.ino) throw new Error("Arc service lock identity changed");
 };
 assertHeld();
 return { store, assertHeld };
}
