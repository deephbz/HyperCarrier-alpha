// The service owns this lock for its lifetime. Never unlink service.lock.
// Perl supplies flock on macOS and Linux. A startup guardian reaps Node
// if its manager disappears before accepting readiness.
import { spawn, type SpawnOptions } from "node:child_process";
import { fstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { storeIncarnation } from "./store.ts";

export const LOCK_BUSY = 73;
const LAUNCHER = String.raw`
use strict;
use warnings;
use Fcntl qw(:flock :DEFAULT F_GETFD F_SETFD FD_CLOEXEC);
use IO::Select;
my $parent;
if (defined $ENV{AMPI_ARC_PARENT_FD}) {
 open($parent, '<&=' . $ENV{AMPI_ARC_PARENT_FD}) or die "Arc launcher: parent pipe: $!\n";
 # A closed manager cannot authorize exec, even before Node can watch EOF.
 if (IO::Select->new($parent)->can_read(0)) { exit(0) if sysread($parent, my $byte, 1) == 0; }
 my $flags = fcntl($parent, F_GETFD, 0);
 fcntl($parent, F_SETFD, $flags & ~FD_CLOEXEC) or die "Arc launcher: inherit parent pipe: $!\n";
}
my ($store, $node, @args) = @ARGV;
defined($store) && defined($node) && @args or die "Arc launcher: missing arguments\n";
sysopen(my $lock, "$store/service.lock", O_RDWR | O_CREAT, 0600)
  or die "Arc launcher: open lock: $!\n";
if ($parent) { syswrite($parent, "W") == 1 or exit(0); }
flock($lock, LOCK_EX | LOCK_NB) or exit(73);
if ($parent) { syswrite($parent, "L") == 1 or exit(0); }
my $fd = fileno($lock);
my $flags = fcntl($lock, F_GETFD, 0);
defined($flags) or die "Arc launcher: get fd flags: $!\n";
fcntl($lock, F_SETFD, $flags & ~FD_CLOEXEC)
  or die "Arc launcher: inherit lock: $!\n";
$^F = $fd;
$ENV{AMPI_ARC_LOCK_FD} = "$fd";
$ENV{AMPI_ARC_STORE} = $store;
if ($parent) {
 pipe(my $reply, my $output) or die "Arc launcher: readiness pipe: $!\n";
 my $child;
 my $cancel = sub {
  if (defined($child) && $child > 0) { kill 9, $child; waitpid($child, 0); }
  exit(0);
 };
 $SIG{TERM} = $cancel;
 $SIG{INT} = $cancel;
 $SIG{PIPE} = 'IGNORE';
 $child = fork();
 defined($child) or die "Arc launcher: fork: $!\n";
 if ($child == 0) {
  $SIG{TERM} = 'DEFAULT'; $SIG{INT} = 'DEFAULT'; $SIG{PIPE} = 'DEFAULT';
  close($parent); close($reply);
  delete $ENV{AMPI_ARC_PARENT_FD};
  open(STDOUT, '>&', $output) or die "Arc launcher: child stdout: $!\n";
  close($output);
  exec {$node} $node, @args;
  die "Arc launcher: exec node: $!\n";
 }
 close($output); close($lock);
 my $watch = IO::Select->new($parent, $reply);
 while (1) {
  for my $input ($watch->can_read()) {
   my $count = sysread($input, my $bytes, 8192);
   $cancel->() unless defined($count);
   if (fileno($input) == fileno($parent)) {
    $cancel->() unless $count == 1 && $bytes eq 'R';
    # R transfers the child to its independent resident lifetime.
    close($parent); close($reply); exit(0);
   }
   $cancel->() if $count == 0;
   while (length($bytes)) {
    my $sent = syswrite(STDOUT, $bytes);
    $cancel->() unless defined($sent) && $sent > 0;
    substr($bytes, 0, $sent, '');
   }
  }
 }
}
exec {$node} $node, @args;
die "Arc launcher: exec node: $!\n";
`;

export function launchLocked(store: string, nodeArgs: string[], options: SpawnOptions = {}, node = process.execPath) {
 mkdirSync(store, { recursive: true, mode: 0o700 });
 storeIncarnation(store, true);
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
