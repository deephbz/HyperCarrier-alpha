#!/bin/sh
# Shared HC plugin bootstrap. Resolve Node without changing the server environment.
# Plugin scripts and their dependencies remain responsible for their own behavior.

plugin=${HERDR_PLUGIN_ID:-unknown}
config_file=${HERDR_PLUGIN_CONFIG_DIR:+$HERDR_PLUGIN_CONFIG_DIR/node-path}

missing() {
    printf '%s\n' "Herdr plugin $plugin: node not found; set HERDR_NODE or write an absolute Node path to ${config_file:-node-path in the plugin config directory}." >&2
    exit 127
}

launch() {
    node=$1
    shift
    [ -n "$node" ] && [ -x "$node" ] && [ ! -d "$node" ] || return 1
    version=$("$node" --version 2>/dev/null) || return 1
    major=${version#v}
    major=${major%%.*}
    case $major in ''|*[!0-9]*) return 1 ;; esac
    printf 'Herdr plugin %s: %s %s\n' "$plugin" "$node" "$version" >&2
    if [ "$major" -lt 22 ]; then
        printf 'Herdr plugin %s: Node major 22 or newer required; set HERDR_NODE or %s.\n' "$plugin" "${config_file:-node-path in the plugin config directory}" >&2
        exit 1
    fi
    exec "$node" "$@"
}

# Explicit configuration fails closed rather than silently selecting another runtime.
if [ -n "$config_file" ] && [ -f "$config_file" ]; then
    IFS= read -r configured < "$config_file" || :
    case $configured in /*) launch "$configured" "$@" ;; esac
    missing
fi
if [ -n "${HERDR_NODE:-}" ]; then
    case $HERDR_NODE in /*) launch "$HERDR_NODE" "$@" ;; esac
    missing
fi
launch "$(command -v node 2>/dev/null)" "$@"

for candidate in /opt/homebrew/bin/node /usr/local/bin/node \
    "${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}/aliases/default/bin/node" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node"; do
    launch "$candidate" "$@"
done

# nvm aliases contain version names, not executable paths. Resolve alias chains.
nvm_dir=${NVM_DIR:-$HOME/.nvm}
alias=default
remaining=8
while [ "$remaining" -gt 0 ]; do
    remaining=$((remaining - 1))
    found=$(for file in "$nvm_dir"/alias/$alias; do
        [ -f "$file" ] || continue
        IFS= read -r value < "$file" || :
        printf '%s\n' "$value"
    done | sort -t . -k1.2,1nr -k2,2nr -k3,3nr | head -n 1)
    [ -n "$found" ] || break
    alias=$found
    case $alias in v[0-9]*|[0-9]*) break ;; esac
done
case $alias in
    [0-9]*) alias=v$alias ;;
    node|stable) alias=v ;;
esac
case $alias in
    v|v[0-9]*)
        # Match nvm's partial-version aliases and select the highest numeric version.
        versions=$(for dir in "$nvm_dir"/versions/node/v*; do
            [ -d "$dir" ] || continue
            name=${dir##*/}
            case $name in
                ("$alias"|"$alias".*) printf '%s\n' "${name#v}" ;;
                (*) [ "$alias" = v ] && printf '%s\n' "${name#v}" ;;
            esac
        done | sort -t . -k1,1nr -k2,2nr -k3,3nr)
        for version in $versions; do
            launch "$nvm_dir/versions/node/v$version/bin/node" "$@"
        done
        ;;
esac
for candidate in "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node"; do
    launch "$candidate" "$@"
done

# Run profile code only if all cheaper resolution channels failed.
login_node=$("${SHELL:-/bin/sh}" -lc 'command -v node' 2>/dev/null) || login_node=
launch "$login_node" "$@"
missing
