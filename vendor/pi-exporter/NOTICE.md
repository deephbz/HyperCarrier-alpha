# Temporary Pi native-export provider

HyperCarrier redistributes `@earendil-works/pi-coding-agent` 0.80.10 under the
MIT license in [`LICENSE`](LICENSE). The checksum-locked npm artifact starts
from the published package at release commit
`8dc78834cde4e329284cf505f9e3f99763df5529` and applies only the native-export
template change from public fork commit
`2c31ffc14735315638abf02078117bbbf7868ac0`. The narrow patch replaces
recursive native-export tree traversals with iterative traversals.

[`provider.json`](provider.json) is the machine-readable authority for the
source revisions, published base integrity, package identity, capability,
artifact byte size, SHA-256, npm SHA-512 integrity, and removal condition.
[`deep-tree.patch`](deep-tree.patch) preserves the exact public patch. To
reproduce the overlay without invoking Pi's mutable model-catalog build:

```sh
git clone https://github.com/earendil-works/pi.git pi-source
git -C pi-source checkout --detach 8dc78834cde4e329284cf505f9e3f99763df5529
git -C pi-source apply /path/to/deep-tree.patch
npm pack --ignore-scripts @earendil-works/pi-coding-agent@0.80.10
mkdir package
tar -xzf earendil-works-pi-coding-agent-0.80.10.tgz -C package --strip-components=1
cp pi-source/packages/coding-agent/src/core/export-html/template.js \
  package/dist/core/export-html/template.js
npm pack --ignore-scripts ./package
```

The package is a temporary compatibility provider, not a HyperCarrier fork of
Pi's native HTML format. Remove it once a released upstream Pi version passes
the same deep-tree export and exact-entry navigation regressions, then repin
Live Detail without changing its Rarebit-first interface. The `deephbz/pi`
commit and branch are immutable upstream patch evidence, not a fourth
HyperCarrier-maintained product or source repository; this checked-in patch,
artifact, manifest, and notice are the complete release source bundle. After a
conforming upstream release, delete this provider bundle and abandon the
temporary fork branch.
