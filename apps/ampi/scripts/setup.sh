#!/usr/bin/env bash
# Sets up AmPi from this checkout on this machine: dependencies, the window, and an `ampi` launcher on PATH.
# Run it on your Mac and on every Linux host you want to reach over SSH. Safe to run again after `git pull`.
#
#   apps/ampi/scripts/setup.sh [--bin-dir DIR]
#
# --bin-dir   where to put the `ampi` launcher (default ~/.local/bin). Remote hosts need a directory on the PATH of
#             non-interactive SSH commands; /usr/local/bin always is. Do not run this script with sudo: when the
#             directory needs root, it prints the one sudo command that installs the launcher.
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
while [ $# -gt 0 ]; do
	case "$1" in
	--bin-dir) BIN_DIR="$2"; shift 2 ;;
	-h | --help) sed -n '2,10p' "$0"; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

step "1/4 Node"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node is not installed. Install Node 22.23.4+, 24.22.1+, or 26.12.1+ (https://nodejs.org or fnm), then run this again."
"$NODE" --input-type=module -e "import { nodeIsPatched } from '$(cd "$(dirname "$0")/../bin" && pwd)/node-floor.mjs'; process.exit(nodeIsPatched(process.versions.node) ? 0 : 1)" ||
	fail "Node $("$NODE" -v) is not supported. AmPi needs Node 22.23.4+, 24.22.1+, or 26.12.1+ (CVE-2026-111497 fixes)."
echo "✓ $("$NODE" -v) at $NODE"

step "2/4 Dependencies"
cd "$REPO"
# Rarebit's selection comes from its own repository (a Git submodule); AmPi needs only that one.
if [ ! -f packages/hc-rarebit/package.json ]; then
	git submodule update --init packages/hc-rarebit || fail "Could not fetch packages/hc-rarebit. Check access to its repository (see .gitmodules), then run this again."
fi
npm install --workspace @hypercarrier/ampi --include-workspace-root=false --no-audit --no-fund --loglevel=error
echo "✓ installed"

step "3/4 Window"
npm run --silent build:web --workspace @hypercarrier/ampi >/dev/null
echo "✓ built apps/ampi/web/dist"

step "4/4 Launcher"
mkdir -p "$BIN_DIR" 2>/dev/null || true
# The launcher names this Node by absolute path, so SSH commands (which skip shell start-up files and nvm) find it.
LAUNCHER="${AMPI_HOME:-$HOME/.ampi}/launcher"
mkdir -p "$(dirname "$LAUNCHER")"
cat >"$LAUNCHER" <<LAUNCHER
#!/bin/sh
exec "$NODE" "$REPO/apps/ampi/bin/ampi.mjs" "\$@"
LAUNCHER
chmod 755 "$LAUNCHER"
if [ -w "$BIN_DIR" ]; then
	cp "$LAUNCHER" "$BIN_DIR/ampi"
	echo "✓ $BIN_DIR/ampi"
else
	# Only this one file needs root; running the whole script as root would leave node_modules owned by root.
	fail "$BIN_DIR needs root. Install the launcher with:
    sudo install -m 755 $LAUNCHER $BIN_DIR/ampi
  then run: ampi doctor"
fi
FOUND="$(command -v ampi || true)"
case ":$PATH:" in
*":$BIN_DIR:"*) [ "$FOUND" = "$BIN_DIR/ampi" ] || printf '! Another ampi comes first on PATH (%s); remove it or put %s earlier.\n' "$FOUND" "$BIN_DIR" ;;
*) printf '! %s is not on PATH%s. Add this to your shell profile, then open a new terminal:\n    export PATH="%s:$PATH"\n' "$BIN_DIR" "${FOUND:+ (another ampi is: $FOUND)}" "$BIN_DIR" ;;
esac

step "Check"
"$BIN_DIR/ampi" doctor || true

cat <<NEXT

Next:
  • Start AmPi:      ampi hub --open        (prints and opens the window's link)
  • On a Mac app:    apps/ampi/macos/scripts/build-app.sh, then open apps/ampi/macos/build/AmPi.app
  • Remote Linux:    run this script there with --bin-dir /usr/local/bin, then use + Add host in the window
  • Anytime:         ampi doctor
NEXT
