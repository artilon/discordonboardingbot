#!/usr/bin/env bash
#
# Copies the MessageAvatarStatus userplugin into a Vencord (or Equicord) source
# checkout, and optionally builds + injects it.
#
#   ./install-into-vencord.sh /path/to/Vencord          # just copy the plugin
#   ./install-into-vencord.sh /path/to/Vencord --build  # copy, build, inject
#
set -euo pipefail

PLUGIN_NAME="messageAvatarStatus"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$PLUGIN_NAME"

usage() {
    echo "usage: $0 /path/to/Vencord [--build]" >&2
    echo "       --build also runs 'pnpm build' and 'pnpm inject' in the checkout" >&2
    exit 1
}

[ $# -ge 1 ] || usage
VENCORD_DIR="$1"
DO_BUILD="${2:-}"

if [ ! -f "$VENCORD_DIR/package.json" ] || [ ! -d "$VENCORD_DIR/src" ]; then
    echo "error: '$VENCORD_DIR' does not look like a Vencord/Equicord checkout (no package.json / src)." >&2
    exit 1
fi

if [ ! -f "$SOURCE_DIR/index.tsx" ]; then
    echo "error: '$SOURCE_DIR/index.tsx' is missing - run this script from the vencord-plugin folder." >&2
    exit 1
fi

TARGET_DIR="$VENCORD_DIR/src/userplugins/$PLUGIN_NAME"
mkdir -p "$VENCORD_DIR/src/userplugins"

if [ -d "$TARGET_DIR" ]; then
    echo "Replacing existing $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

cp -r "$SOURCE_DIR" "$TARGET_DIR"
echo "Copied plugin to $TARGET_DIR"

if [ "$DO_BUILD" != "--build" ]; then
    cat <<EOF

Done. Now build your client:

    cd "$VENCORD_DIR"
    pnpm install     # first time only
    pnpm build
    pnpm inject      # desktop app; skip for the browser/Vesktop build

Then enable "MessageAvatarStatus" in Vencord settings -> Plugins.
EOF
    exit 0
fi

command -v pnpm >/dev/null 2>&1 || {
    echo "error: pnpm is not on PATH (see https://pnpm.io/installation)" >&2
    exit 1
}

cd "$VENCORD_DIR"
echo "Building..."
pnpm install
pnpm build
pnpm inject

echo
echo "Built and injected. Start Discord and enable MessageAvatarStatus in Vencord settings -> Plugins."
