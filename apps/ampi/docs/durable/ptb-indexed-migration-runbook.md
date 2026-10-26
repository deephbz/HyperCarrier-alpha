# Perf Team authority: migration and backup restore

Status: proposed execution procedure. The owner must approve the exact candidate,
the restart of persisted work, and backup restoration before execution. This
file grants no deployment authority. Do not submit new work during the hold.

The [package contract](../../../../packages/pi-team-durable/README.md) owns the
migration semantics. The first authority open automatically migrates rc.7 in
one transaction, in one direction. Startup or a Team read can cause that open.
The transaction writes indexed authority and raises six shared PTB kinds to
version 2. Team data stays; the other five addresses retain fences. Native
pi-durable documents keep their own versions. No separate migration command
runs. Old typed reads fail after migration, but the fence cannot stop an older
process that already runs. **Stop every older node on each host before open.**

The node is not the only owner of AMPI_HOME. A hub can hold nested
`durable-cache` directories through SQLite `owner.lock` handles. Follow the
[ownership rules](cutover-runbook.md#ownership-facts-observed): never delete a
lock or move its directory while an owner holds it. This procedure stops the
hub by default and includes its cache in the backup. It does not exclude caches.

Rollback means restoring the whole stopped backup and running the old build
from its untouched deployment checkout. The candidate installs into a separate
fresh checkout; no step checks out, installs or builds in the old checkout.
Checking out old code against migrated data is not rollback. Restoration loses
all work admitted since the backup. Keep the failed home for investigation.

## 1. Private coordinates and day-of baseline

Execute on both Mac and linuxbox. All paths, service names, host addresses and IDs
come from the lead's private execution record. Do not put them in Git. Use
Bash with `set -euo pipefail`; an unexpected result stops the procedure.
Save each section as a reviewed script file and run it with `bash`; do not paste
commands line by line into an interactive shell. `set -e` and section 5's ERR
trap can close that shell. Save the resolved variable assignments below in a
private `coordinates.env` and source it at the start of each section script.
Resolve B once; keep its exact value when sourcing. Do not repeat directory
creation, baseline capture or other setup actions when sourcing variables.
Section 6 uses its saved recovery variable block to reload the same coordinates.

```bash
set -euo pipefail
umask 077
TREE="<host-deployment-checkout>"
CAND="<host-new-candidate-checkout>"
SOURCE="<host-candidate-clone-source>"
NODE="<host-tested-node-executable>"
NPM="<host-npm-for-that-node>"
GUIDE="<host-reviewed-candidate-checkout>"
export AMPI_HOME="<host-store-home>"
OLD="<approved-old-full-commit>"
NEW="<approved-tested-candidate-full-commit>"
B="<private-backup-prefix>$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$B"
printf '%s\n' "$B" > "<private-backup-pointer>"
for key in TREE CAND SOURCE NODE NPM GUIDE AMPI_HOME OLD NEW; do
 printf '%s\n' "${!key}" > "$B/$key"
done
test "$(git -C "$TREE" rev-parse HEAD)" = "$OLD"
test -z "$(git -C "$TREE" status --porcelain)"
test ! -e "$CAND"
case "$CAND/" in "$TREE/"*) echo 'STOP: CAND is inside TREE'; false ;; esac
case "$TREE/" in "$CAND/"*) echo 'STOP: TREE is inside CAND'; false ;; esac
test "$(git -C "$GUIDE" rev-parse HEAD)" = "$NEW"
"$NODE" --version
git -C "$GUIDE" submodule status > "$B/candidate-pins.txt"
cp "$GUIDE/apps/ampi/scripts/durable/migration-check.mjs" "$B/migration-check.mjs"
cp "$GUIDE/apps/ampi/scripts/durable/migration-lock-check.mjs" "$B/migration-lock-check.mjs"
"$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node inventory > "$B/inventory-before.txt"
cat > "$B/tree-fingerprint.mjs" <<'JS'
// Hashes every entry inside each node_modules and dist directory of a checkout, without following links.
import {lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
const root=process.argv[2], hash=createHash('sha256'); let entries=0;
function walk(p,inside){
 const s=lstatSync(p);
 if(inside){hash.update(`${relative(root,p)}\0${s.mode}\0${s.size}\0${s.mtimeMs}\0${s.isSymbolicLink()?readlinkSync(p):''}\n`);entries++;}
 if(!s.isDirectory())return;
 for(const n of readdirSync(p).sort())if(n!=='.git')walk(join(p,n),inside||n==='node_modules'||n==='dist');
}
walk(root,false);
console.log(`${hash.digest('hex')} entries=${entries}`);
JS
```

Require the tested Node version, exact revisions, clean deployment checkout,
an absent CAND outside TREE, and every candidate pin present without `+`, `-`
or `U`. TREE stays at OLD with its installed dependencies for rollback. A fresh
OLD install on Mac needs the Xcode license, so rollback reuses TREE as it is.
Never run `git checkout`, `npm ci`, `npm install` or a build in TREE. SOURCE is
the clone source for CAND: the repository, or a staged bundle on linuxbox. Stage
candidate source and submodule bundles on linuxbox before stopping; do not assume
linuxbox can reach GitHub. Staging source must not start a node or open a store.

Record day-of thread, Team and Worker counts in `$B/approved-counts.json`:
`{"threadCount":8,"teamCount":2,"workerCount":4}` is a shape example only.
`teamCount` is the number of distinct Team ids on public thread rows, and
`workerCount` sums every Team's Workers. The helper counts Teams by the same
Team ids it compares. Do not count Teams from raw store documents: their kinds
are JSON-encoded, so a plain kind match finds none.
Keep the old node running through the `before` helper. Use current counts
for that host. Record expected Task states,
Worker bindings and the owner's restart/rollback approval in
`$B/baseline-approval.txt`. Do not copy historical counts from an earlier run.

```bash
test -s "$B/baseline-approval.txt"
"$NODE" "$B/migration-check.mjs" "$B" before "$B/approved-counts.json"
```

Require `PASS before`, `nonIdle=0 queued=0`. Review each private
`expected-status/<team-id>.txt` against that Team's approved Task states. The
helper records public bindings, counts, each Team's Worker count and exact
`/ptb status` text, keyed by Team id, through the existing node socket. It
cannot start a node or open SQLite. A host may carry any number of Teams; a
Team with no lead thread or more than one stops the helper. For a host
without a Team, the helper writes `expected-status/unbound.txt`; require
`No Team is bound to this thread.` Do not create a Team to perform that check.
`newest-worker.txt` names each Team's newest Worker, one `<team-id> <worker-id>`
line per Team, for later UI checks. No controller-log conversation belongs in
public counts.

The helper refuses to overwrite an established baseline. If work changes
before stopping, including a thread closing, use a new private backup directory
and obtain a new baseline and approval.
Do not replace baseline files after migration. Idle rows do not prove native
background tasks are drained: anchors, notifiers and other persisted work can
resume. Their restart needs the owner's approval. Active rows or queued input
stop this procedure; approval alone does not bypass the helper.

The owner approves the counts last, immediately before section 2. Confirm that
the baseline still matches; any intervening thread closure requires a new baseline.

## 2. Identify all owners; stop before backup, deploy or authority open

AmPi stays off for the whole maintenance window until the explicit UI checks
in section 5 or 6. Herdr and Pi panes still work. Do not open or click AmPi.

Time budget: provisionally allow 30 minutes and reserve a quiet hour for rollback.
The disposable node readiness waits took 1.8–2.3 seconds; hub deployment adds
build time and the cutover procedure's 60-second smoke check. Confirm the total
against private backup and deploy timings before the window; no full live-window
duration has been measured.

Inspect the active hub configuration and process arguments. On each host,
record every hub cache root in `$B/hub-cache-roots.txt`, one absolute path per
line. The [hub adapter](../../src/hub/durable-host.ts) places each cache
under `(<Host entry home> or <hub AMPI_HOME>)/durable-cache/`. A remote node's
cache lives on the hub host. Another hub with a different AMPI_HOME can still
own a Host entry's nested cache. An empty file requires a reviewed decision
that this host has no hub cache root. Record each hub PID, its restart owner
(app or supervisor), and its approved stop/start commands privately.

Before stopping the hub, save its recovery record on the hub host under
`$B/hub-original/`. Copy its location into each host's private execution record.
This record must exist before any node candidate starts. It contains:

- `revision`: the full running hub commit, independent of the node's OLD.
- `launch-evidence.txt`: the running PID, executable, arguments, working directory,
  restart owner, and the launch/deploy evidence that binds that process to the
  recorded revision. Cross-check the retained clean checkout and installed
  artifacts. A checkout HEAD alone does not prove what the process loaded.
- `config/`: the exact start configuration, including Host entries, cache roots,
  service/app settings and required environment. Keep credentials in their
  existing secret store; record their references and check availability.
- `start.sh`: the approved command to start that exact retained hub build with
  that configuration. It must not select a branch tip or request a new deploy.
- `verify.sh`: approved checks with modes `running` and `stopped`. Both verify
  the retained revision, artifacts and configuration. `running` also checks
  the process launch evidence and authorized health/Host links; `stopped`
  checks owner absence. Health alone cannot prove the running revision.

The lead reviews these private scripts and confirms that the retained build,
dependencies and configuration can restart without a deployment receipt. If the
running revision cannot be established, or the record and running process
disagree, stop before changing any owner. Scripts must resolve their configuration
from their own record directory and work from a fresh shell.

```bash
test -s "$B/hub-original/revision"
test -s "$B/hub-original/launch-evidence.txt"
test -d "$B/hub-original/config"
test -s "$B/hub-original/start.sh"
test -s "$B/hub-original/verify.sh"
bash "$B/hub-original/verify.sh" running > "$B/hub-original-verified.txt"
(cd "$B/hub-original" && find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; > SHA256SUMS)
printf 'not-requested\n' > "$B/hub-deploy-state"
```

Require a successful verification before stopping. Keep this recovery record
outside AMPI_HOME and unchanged through migration and rollback.

Resolve overlaps before stopping; save the result privately:

```bash
CACHE_ROOTS=()
while IFS= read -r root; do
 test -n "$root"
 CACHE_ROOTS+=("$root")
done < "$B/hub-cache-roots.txt"
"$NODE" "$B/migration-lock-check.mjs" overlap "$AMPI_HOME" "${CACHE_ROOTS[@]}" > "$B/cache-overlap.json"
```

Each `true` identifies a hub cache inside this home after canonical path
resolution. Missing or unreadable roots stop the procedure. Regardless of the
result, stop the hub by default. Disable its automatic restart first. Quit
AmPi or stop the exact hub supervisor using the approved private commands;
verify that its recorded process exits. A disconnected browser is not a
stopped hub. Do not use a deploy command to stop it: deployment can restart it.
Keep the hub stopped through backup and the node startup/check steps.



First prove OLD's bridge honors the hold, on each host, in a disposable home:

```bash
D=$(mktemp -d)
printf 'hold\n' > "$D/autostart-off"
if AMPI_HOME="$D" "$NODE" "$TREE/apps/ampi/bin/ampi.mjs" bridge </dev/null >"$D/out" 2>"$D/err"; then
 echo 'STOP: bridge ignored hold'; false
fi
grep -q 'autostart is off' "$D/err"
test ! -e "$D/node.sock"
AMPI_HOME="$D" "$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node inventory --expect-stopped
```

If this fails, stop and obtain a hub-stop plan. Do not test the live home by
removing its supervisor marker. For this bridge-hold test, disconnected durable
sources are expected. Do not click Reconnect or start a node manually.

After the hub stops, stop the linuxbox node, then the Mac node:

```bash
"$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node uninstall-service --no-autostart
"$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node inventory --expect-stopped > "$B/inventory-stopped.txt"
test -f "$AMPI_HOME/autostart-off"
test ! -e "$AMPI_HOME/supervised"
```

Require owner none and socket silent. On Mac, require the exact service to be
absent; on linuxbox, require it inactive or absent:

```bash
# Mac only
if launchctl print "<mac-service-target>" >"$B/service-check.txt" 2>&1; then
 echo 'STOP: service remains registered'; false
fi
# linuxbox only
if systemctl --user is-active "<linuxbox-service-unit>" >"$B/service-check.txt" 2>&1; then
 echo 'STOP: service remains active'; false
fi
```

Read `service-check.txt`. Permission and connection failures do not prove
absence. Do not substitute `ampi stop`; a supervisor can restart its node.

**On both hosts**, capture the whole-host process census after stopping:

```bash
ps -axo pid=,ppid=,command= > "$B/processes-stopped.txt"
grep -Ei 'ampi|pi-durable|node' "$B/processes-stopped.txt" > "$B/process-candidates.txt" || test "$?" -eq 1
if grep -E 'ampi\.mjs[[:space:]]+node([[:space:]]|$)' "$B/processes-stopped.txt" ||
   grep -F -- "$AMPI_HOME" "$B/processes-stopped.txt"; then
 echo 'STOP: node command or home remains in full census'; false
fi
```

The lead must inspect both files and identify every AmPi node, including
manually launched nodes, older checkouts and other homes. Cross-check every
PID recorded by the pre-stop inventory and supervisor. Require no older node
process on either host. An unrecognized Node process is unresolved evidence;
inspect its executable and arguments before proceeding. Do not terminate
unrelated processes. If another old node owns a different home, obtain an
owner-approved stop plan. Save the reviewed absence decision in
`$B/process-approval.txt`. The grep is a shortlist; the full census controls.
Repeat this read-only census immediately before each deployment/start. Include
all recorded hub PIDs and their restart owners. The single-home inventory
alone cannot establish whole-host absence.

After every owner and restart mechanism is stopped, run the lock probe on
each host. Keep the owners stopped until the archive or move ends:

```bash
"$NODE" "$B/migration-lock-check.mjs" stopped "$AMPI_HOME" "${CACHE_ROOTS[@]}" > "$B/locks-stopped.txt"
```

Require `PASS stopped`. The probe recursively finds every `owner.lock` and
`node-owner.sqlite` in the home and declared cache roots. It tries an exclusive
SQLite transaction, then rolls it back and closes it without changing owner
data. A held/unreadable lock or a symlink fails closed. It does not delete
locks, start owners, or trust stale `owner.json` PIDs. Record the lock count.
A probe proves absence at that instant; disabled restart mechanisms and the
process census must keep that result valid.

## 3. Exact whole-home backup and copy verification

Do this on each stopped host before any candidate deploys. Reject store links
so tar cannot silently omit external database data:

```bash
"$NODE" --input-type=module <<'JS'
import {lstatSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
function walk(p){const s=lstatSync(p);if(s.isSymbolicLink())throw Error('STOP: symlink needs a reviewed backup plan');if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));}
if(lstatSync(process.env.AMPI_HOME).isSymbolicLink())throw Error('STOP: home is a symlink');
walk(join(process.env.AMPI_HOME,'threads'));
JS
test -s "$B/process-approval.txt"
"$NODE" "$B/migration-lock-check.mjs" stopped "$AMPI_HOME" "${CACHE_ROOTS[@]}" > "$B/locks-before-archive.txt"
tar -C "$AMPI_HOME" --exclude='./node.sock' -cpf "$B/home.tar" . 2> "$B/tar-backup.err"
test ! -s "$B/tar-backup.err"
(cd "$B" && shasum -a 256 home.tar > home.tar.sha256 && shasum -a 256 -c home.tar.sha256)
mkdir "$B/check"
tar -C "$B/check" -xpf "$B/home.tar" 2> "$B/tar-check.err"
test ! -s "$B/tar-check.err"
diff -qr "$AMPI_HOME/threads" "$B/check/threads" > "$B/copy-diff.txt"
AMPI_HOME="$B/check" "$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node inventory --expect-stopped > "$B/backup-inventory.txt"
grep '^store ' "$B/inventory-stopped.txt" > "$B/stopped-stores.txt"
grep '^store ' "$B/backup-inventory.txt" > "$B/backup-stores.txt"
cmp "$B/stopped-stores.txt" "$B/backup-stores.txt"
"$NODE" "$B/tree-fingerprint.mjs" "$TREE" > "$B/old-tree.txt"
```

Require checksum `OK`, no tar diagnostics, an empty copy diff and identical
store inventories. `old-tree.txt` fingerprints OLD's installed dependencies and
package builds in TREE; rollback requires the same fingerprint. Keep the whole
stopped home, including metadata, every SQLite database and every WAL/SHM
sidecar. Never copy only `harness.sqlite` from a running store. Inventory
uses a read-only diagnostic path; it does not perform an authority open or
migration. Do not run a candidate node against
`$B/check`: retain this extracted copy unchanged for restoration checks.

Both hosts must pass backup, process review and lock-release checks before
either node deploys. Keep the hub stopped. A bridge hold protects the node;
it does not release a hub's nested cache lock.

## 4. Install exact candidate while the hub stays stopped

Repeat section 2's census on both hosts and require the reviewed absence of
old nodes. Keep the autostart hold. Install NEW as a fresh recursive clone in
CAND; leave TREE untouched:

```bash
test ! -e "$CAND"
git clone --no-checkout "$SOURCE" "$CAND"
git -C "$CAND" checkout --detach "$NEW"
git -C "$CAND" submodule update --init --recursive
test "$(git -C "$CAND" rev-parse HEAD)" = "$NEW"
test -z "$(git -C "$CAND" status --porcelain)"
git -C "$CAND" submodule status > "$B/installed-pins.txt"
cmp "$B/candidate-pins.txt" "$B/installed-pins.txt"
(cd "$CAND" && "$NPM" ci) > "$B/npm-ci.log" 2>&1
"$NODE" "$CAND/apps/ampi/bin/ampi.mjs" version > "$B/candidate-version.txt"
test -z "$(git -C "$CAND" status --porcelain)"
test "$(git -C "$TREE" rev-parse HEAD)" = "$OLD"
test -z "$(git -C "$TREE" status --porcelain)"
"$NODE" "$B/tree-fingerprint.mjs" "$TREE" > "$B/old-tree-after-install.txt"
cmp "$B/old-tree.txt" "$B/old-tree-after-install.txt"
```

Some pins may exist only locally, and linuxbox may not reach GitHub. Before the
submodule update, point each submodule whose URL lacks its pin at the staged
bundle or reviewed local checkout that holds it
(`git -C "$CAND" config submodule.<path>.url <source>`). Do not substitute a
different pin. If `npm ci` cannot reach its registry, stop and obtain a
reviewed offline install plan.

`npm ci` runs the root `prepare` script, which builds each pinned package and
stamps its `dist/.source-commit` with the pinned commit. `ampi version` prints
the node build. It exits non-zero with `StalePackageBuild` when a stamp the
node needs differs from its pin. It starts no node and opens no store. Any
TREE change stops the procedure before a candidate starts. No `ampi node`,
service install or authority probe may precede both backups.

Stage the matching hub candidate, but do not deploy or start it yet. Hub
deployment can restart its process and acquire the nested cache. The node
socket checks in section 5 do not need a hub.

## 5. First open and day-of comparison

Repeat the process census before each start. Start Mac first:

```bash
# Any failed check stops supervisor retries before inspection or rollback.
stop_candidate() {
 "$NODE" "$CAND/apps/ampi/bin/ampi.mjs" node uninstall-service --no-autostart
 echo 'STOP: candidate verification failed; keep hub stopped and follow section 6' >&2
 exit 1
}
trap stop_candidate ERR
LOG_START=$(wc -l < "$AMPI_HOME/node.log")
# Section 6 ends candidate retries only after this marker exists.
printf 'installed\n' > "$B/candidate-service"
# install-service points the service at the checkout that runs it: CAND.
"$NODE" "$CAND/apps/ampi/bin/ampi.mjs" node install-service
# install-service returns before the socket exists. ENOENT is normal here.
"$NODE" --input-type=module - "$NODE" "$CAND/apps/ampi/bin/ampi.mjs" <<'JS'
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const start=Date.now(), deadline=start+60_000;
let ready=false;
while(Date.now()<deadline){
 if(existsSync(join(process.env.AMPI_HOME,'node.sock'))){
  const r=spawnSync(process.argv[2],[process.argv[3],'node','inventory'],{
   encoding:'utf8',timeout:Math.max(1,Math.min(2000,deadline-Date.now()))});
  if(r.status===0 && /^home .* · socket answers · /m.test(r.stdout)){ready=true;break;}
 }
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(250,Math.max(0,deadline-Date.now())));
}
console.log(`readiness ${ready?'PASS':'STOP'} elapsedMs=${Date.now()-start}`);
if(!ready)process.exit(1);
JS
"$NODE" "$B/migration-check.mjs" "$B" after
"$NODE" "$CAND/apps/ampi/bin/ampi.mjs" node inventory > "$B/inventory-after.txt"
awk '/^store / {print $2}' "$B/inventory-stopped.txt" | sort > "$B/stores-before.ids"
awk '/^store / {print $2}' "$B/inventory-after.txt" | sort > "$B/stores-after.ids"
comm -23 "$B/stores-before.ids" "$B/stores-after.ids" > "$B/missing-stores.ids"
test ! -s "$B/missing-stores.ids"
tail -n +"$((LOG_START+1))" "$AMPI_HOME/node.log" > "$B/startup.log"
if grep -Ein 'migration.*fail|failed.*migrat|newer version|corrupt|uncaught|unhandled' "$B/startup.log"; then
 echo 'STOP: inspect startup failure'; false
fi
trap - ERR
```

Require service executable and arguments to match NODE/CAND, `PASS after`,
unchanged public thread/Team/Worker counts and bindings, the same Team ids,
each Team's Worker count and exact `/ptb status`,
idle rows, empty queues, and all old store IDs readable. Use `launchctl print`
on Mac; use `systemctl --user status` and `systemctl --user show -p ExecStart`
on linuxbox. Raw inventory conversation counts can grow for internal controller
logs; public thread counts must not grow for them.

Only after Mac's node checks pass, start linuxbox and repeat its node checks.
A mismatch or readiness timeout first runs `node uninstall-service --no-autostart`.
If uninstall fails, stop here and resolve the reported service/owner before any move.
Keep the hub stopped and trigger the approved rollback decision.

After both nodes pass, deploy/start the matching hub through the approved
[cutover procedure](cutover-runbook.md). Require the integration tip and
reviewed checkout to equal NEW before requesting deployment; the deployment
queue can otherwise select a newer tip. On the hub host, write `requested` to
`$B/hub-deploy-state` **before** sending the deploy request. Save `$B/hub-deploy.json` with
`status=pass`, `target=NEW` and the previous hub revision. Stop on a different
target or failed smoke check. Do not call `build-app.sh` directly.

Then compare each Team's `/ptb status` and Team panel to the approved baseline.
Open each Team's newest Worker from `newest-worker.txt`. Its existing Team
notices must keep their badge/sender and its composer must be enabled. Do not
send a test prompt.
Record the UI result privately. Skip Team UI checks on a host with no Team.

## 6. Restore backup on failed verification

If restoration was not pre-approved, stop the hub and both candidate nodes and ask the
owner. Do not restore unilaterally. In a fresh Bash shell on each host:

```bash
set -euo pipefail
B=$(head -n 1 "<private-backup-pointer>")
test -d "$B"
for key in TREE CAND SOURCE NODE NPM GUIDE AMPI_HOME OLD NEW; do
 test -s "$B/$key"
 IFS= read -r "$key" < "$B/$key"
done
export AMPI_HOME
test -x "$NODE"
test -d "$TREE"
```

First end candidate retries on each host. A host that never reached section 5's
service install has no candidate service:

```bash
if test -e "$B/candidate-service"; then
 "$NODE" "$CAND/apps/ampi/bin/ampi.mjs" node uninstall-service --no-autostart
fi
```

Reload CACHE_ROOTS from `$B/hub-cache-roots.txt` with section 2's loop.
Stop the hub and disable its restart mechanism first, then stop the linuxbox and
Mac nodes. Repeat section 2's supervisor, inventory, whole-host census and
lock probes. Never move the home while a nested hub cache is owned. After
both hosts and every cache owner prove stopped:

```bash
(cd "$B" && shasum -a 256 -c home.tar.sha256)
FAILED="$B/failed-home-$(date -u +%Y%m%dT%H%M%SZ)"
"$NODE" "$B/migration-lock-check.mjs" stopped "$AMPI_HOME" "${CACHE_ROOTS[@]}" > "$B/locks-before-move.txt"
mv "$AMPI_HOME" "$FAILED"
mkdir -m 700 "$AMPI_HOME"
tar -C "$AMPI_HOME" -xpf "$B/home.tar" 2> "$B/tar-restore.err"
test ! -s "$B/tar-restore.err"
diff -qr "$B/check/threads" "$AMPI_HOME/threads" > "$B/restore-diff.txt"
if test -d "$B/check/durable-cache"; then
 diff -qr "$B/check/durable-cache" "$AMPI_HOME/durable-cache" > "$B/restore-cache-diff.txt"
fi
"$NODE" "$B/migration-lock-check.mjs" stopped "$AMPI_HOME" "${CACHE_ROOTS[@]}" > "$B/locks-restored.txt"
test -f "$AMPI_HOME/autostart-off"
test ! -e "$AMPI_HOME/supervised"
test "$(git -C "$TREE" rev-parse HEAD)" = "$OLD"
test -z "$(git -C "$TREE" status --porcelain)"
"$NODE" "$B/tree-fingerprint.mjs" "$TREE" > "$B/old-tree-rollback.txt"
cmp "$B/old-tree.txt" "$B/old-tree-rollback.txt"
"$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node inventory --expect-stopped > "$B/inventory-restored.txt"
grep '^store ' "$B/inventory-restored.txt" > "$B/restored-stores.txt"
cmp "$B/stopped-stores.txt" "$B/restored-stores.txt"
```

FAILED retains the candidate home, including leftover `backups/<storeId>` copies
from failed opens and retries. Do not copy them into the restored home or infer
rollback safety from candidate `store.json` metadata.

TREE is the rollback build: OLD at its original revision with its original
installed dependencies. A fingerprint mismatch means something changed TREE;
stop for owner resolution. Do not check out, reinstall or rebuild OLD in place.
CAND stays on disk for investigation.

Require checksum `OK`, no archive warning, byte-identical store trees and
identical inventories, an unchanged TREE and released restored cache locks.
Start Mac from OLD with `"$NODE" "$TREE/apps/ampi/bin/ampi.mjs" node install-service`;
it points the service back at TREE. Require service executable and arguments
to match NODE/TREE. Repeat section 5's bounded readiness wait, run with
TREE's `bin/ampi.mjs`, before helper `after`, then start linuxbox and repeat its
node checks. Only after both old nodes pass, recover the hub on
the hub host from `$B/hub-original/`:

```bash
(cd "$B/hub-original" && shasum -a 256 -c SHA256SUMS)
test -s "$B/hub-deploy-state"
IFS= read -r HUB_DEPLOY_STATE < "$B/hub-deploy-state"
```

- `not-requested`: no hub deploy has been requested. A first-node failure takes
  this path. No `hub-deploy.json` is needed. Verify that the retained original
  build and configuration are unchanged, then run the recorded start command:

  ```bash
  test "$HUB_DEPLOY_STATE" = not-requested
  bash "$B/hub-original/verify.sh" stopped > "$B/hub-original-stopped.txt"
  bash "$B/hub-original/start.sh" > "$B/hub-original-started.txt" 2>&1
  bash "$B/hub-original/verify.sh" running > "$B/hub-original-recovered.txt"
  ```

- `requested`: reconcile the deploy queue and actual installed hub state first.
  A missing/failed receipt does not prove that no deployment occurred. Stop any
  candidate hub and its restart owner. Restore the exact revision recorded in
  `hub-original/revision` through the approved cutover procedure, with the saved
  original configuration. Compare any receipt's previous revision to this record;
  a mismatch stops for owner resolution. Require the successful restore receipt
  and run the recorded `verify.sh running` checks.
- Missing or unrecognized state: stop for owner resolution. Never infer the old
  hub revision from NEW, node OLD, a branch tip or a missing deploy receipt.

Repeat the UI checks. Retain FAILED, the original recovery record and all
receipts privately. Release the submission hold only after both hosts pass or
the owner approves a separate recovery plan.

## Evidence boundary

launchd retries a failed process startup every 10 seconds. A store-open failure
normally leaves the node running with bounded internal retries. After a successful
pre-migration backup, that process does not repeat the backup for the same store.
A process restart clears that memory and can create another copy. Do not rely on
`store.json` staying old.

Tests of the helper use disposable synthetic stores and copied homes only,
with zero, one and two Teams.
They establish the helper's public perf-authority comparison and refusal
paths. Package migration tests establish the transactional rc.7 conversion.
Neither proves a live host's service, filesystem restore or operator UI.
Record those day-of checks separately. This runbook contains no claim that a
live migration or restore has run.
