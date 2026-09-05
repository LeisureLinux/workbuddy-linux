#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ID="${WORKBUDDY_APP_ID:-workbuddy}"
APP_DISPLAY_NAME="${WORKBUDDY_APP_DISPLAY_NAME:-WorkBuddy}"
INSTALL_DIR="${WORKBUDDY_INSTALL_DIR:-$SCRIPT_DIR/workbuddy-app}"
ELECTRON_VERSION="${ELECTRON_VERSION:-41.1.1}"
ELECTRON_HEADERS_URL="${ELECTRON_HEADERS_URL:-${npm_config_disturl:-${NPM_CONFIG_DISTURL:-https://artifacts.electronjs.org/headers/dist}}}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-}"
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"
PROVIDED_INPUT=""
FRESH=0

. "$SCRIPT_DIR/scripts/lib/common.sh"
. "$SCRIPT_DIR/scripts/lib/dmg.sh"
. "$SCRIPT_DIR/scripts/lib/electron.sh"
. "$SCRIPT_DIR/scripts/lib/native-modules.sh"
. "$SCRIPT_DIR/scripts/lib/linux-patches.sh"

usage() {
    cat <<'HELP'
Usage: ./install.sh [--fresh] [path/to/WorkBuddy.dmg | path/to/WorkBuddy.app]

Builds a local Linux Electron app from a user-owned official WorkBuddy
macOS Intel/x64 DMG or extracted .app bundle. With no path, the installer
expects exactly one official DMG in downloads/.

Environment:
  WORKBUDDY_INSTALL_DIR     Output app directory (default: ./workbuddy-app)
  ELECTRON_MIRROR           Optional Electron runtime mirror
  ELECTRON_HEADERS_URL      Electron headers dist URL for native rebuilds
  WORKBUDDY_DISABLE_SANDBOX Set to 1 to append --no-sandbox flags explicitly
  WORKBUDDY_LOCAL_MODE      Set to 1 to start the local CLI Web UI instead of Desktop
  WORKBUDDY_LOCAL_PORT      Local CLI Web UI port (default: 7890)
HELP
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --fresh)
                FRESH=1
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                usage >&2
                exit 2
                ;;
            *)
                [ -z "$PROVIDED_INPUT" ] || error "Only one input path can be provided"
                PROVIDED_INPUT="$1"
                ;;
        esac
        shift
    done
}

check_deps() {
    require_cmd python3
    require_cmd curl
    require_cmd unzip
    require_cmd node
    require_cmd npm
    require_cmd npx
    find_7z >/dev/null
}

validate_app_identity() {
    [[ "$APP_ID" =~ ^[A-Za-z0-9._-]+$ ]] || error "WORKBUDDY_APP_ID contains unsafe characters: $APP_ID"
    [[ "$APP_DISPLAY_NAME" != *$'\n'* && "$APP_DISPLAY_NAME" != *$'\r'* ]] || error "WORKBUDDY_APP_DISPLAY_NAME must not contain newlines"
}

desktop_value() {
    local value="$1"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || error "Desktop entry value must not contain newlines"
    printf '%s' "$value" | python3 -c 'import sys; print(sys.stdin.read().replace("\\\\", "\\\\\\\\"))'
}

desktop_exec_path() {
    local value="$1"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || error "Desktop Exec path must not contain newlines"
    printf '%s' "$value" | python3 -c 'import sys
s = sys.stdin.read().replace("\\\\", "\\\\\\\\").replace("\"", "\\\\\"").replace("`", "\\\\`").replace("$", "\\\\$")
print("\"" + s + "\"")'
}

prepare_install_dir() {
    if [ -e "$INSTALL_DIR" ]; then
        if [ "$FRESH" -eq 1 ]; then
            rm -rf "$INSTALL_DIR"
        else
            info "Replacing existing install dir: $INSTALL_DIR"
            rm -rf "$INSTALL_DIR"
        fi
    fi
    mkdir -p "$INSTALL_DIR"
}

copy_app_payload() {
    local app_bundle="$1"
    local resources_dir="$app_bundle/Contents/Resources"
    local app_asar="$resources_dir/app.asar"
    local app_asar_unpacked="$resources_dir/app.asar.unpacked"
    local app_payload="$resources_dir/app"

    # WorkBuddy uses app.asar + app.asar.unpacked (unlike CodeBuddy's plain app dir)
    if [ -f "$app_asar" ]; then
        info "Copying WorkBuddy app.asar payload"
        mkdir -p "$INSTALL_DIR/resources"
        cp "$app_asar" "$INSTALL_DIR/resources/app.asar"

        if [ -d "$app_asar_unpacked" ]; then
            info "Copying app.asar.unpacked"
            cp -a "$app_asar_unpacked" "$INSTALL_DIR/resources/app.asar.unpacked"
        fi
    elif [ -d "$app_payload" ]; then
        info "Copying WorkBuddy app payload (directory mode)"
        rm -rf "$INSTALL_DIR/resources/app"
        mkdir -p "$INSTALL_DIR/resources"
        cp -a "$app_payload" "$INSTALL_DIR/resources/app"
    else
        error "No app.asar or app directory found in: $resources_dir"
    fi

    if [ -f "$resources_dir/node_modules.asar" ]; then
        cp "$resources_dir/node_modules.asar" "$INSTALL_DIR/resources/" 2>/dev/null || true
    fi
}

write_icon() {
    local app_bundle="$1"
    local icon_source="$app_bundle/Contents/Resources/icon.icns"
    local icon_target="$INSTALL_DIR/.workbuddy-linux/workbuddy.png"
    local icon_tmp="$WORK_DIR/icon"

    mkdir -p "$INSTALL_DIR/.workbuddy-linux" "$icon_tmp"

    # Also check for icon in app.asar.unpacked/resources
    if [ ! -f "$icon_source" ]; then
        local alt_icon="$app_bundle/Contents/Resources/app.asar.unpacked/resources/icon.png"
        if [ -f "$alt_icon" ]; then
            cp "$alt_icon" "$icon_target"
            return 0
        fi
        warn "WorkBuddy icon not found in app bundle"
        return 0
    fi

    if command -v icns2png >/dev/null 2>&1; then
        icns2png -x -s 256 -o "$icon_tmp" "$icon_source" >/dev/null 2>&1 || true
        local generated
        generated="$(find "$icon_tmp" -type f -name "*.png" | sort | tail -n 1)"
        if [ -n "$generated" ]; then
            cp "$generated" "$icon_target"
            return 0
        fi
    fi

    if command -v magick >/dev/null 2>&1; then
        magick "$icon_source" "$icon_target" >/dev/null 2>&1 && return 0
    elif command -v convert >/dev/null 2>&1; then
        convert "$icon_source" "$icon_target" >/dev/null 2>&1 && return 0
    fi

    # Fallback: extract PNG directly from ICNS with python3 (no extra libs needed).
    # ICNS 256x256+ entries embed raw PNG data that we can locate by signature.
    if python3 - "$icon_source" "$icon_target" <<'PY' 2>/dev/null; then
import struct, sys

def extract(icns_path, out_path):
    # ICNS entry types containing PNG, ordered by preference
    wanted = [b'ic08', b'ic09', b'ic13', b'ic14', b'ic10', b'ic07']
    png_sig = b'\x89PNG'
    with open(icns_path, 'rb') as f:
        if f.read(4) != b'icns':
            return False
        total = struct.unpack('>I', f.read(4))[0]
        found = {}
        while f.tell() < total:
            etype = f.read(4)
            if len(etype) < 4:
                break
            esize = struct.unpack('>I', f.read(4))[0]
            edata = f.read(esize - 8)
            if etype in wanted and edata[:4] == png_sig:
                found[etype] = edata
        for t in wanted:
            if t in found:
                with open(out_path, 'wb') as o:
                    o.write(found[t])
                return True
    return False

sys.exit(0 if extract(sys.argv[1], sys.argv[2]) else 1)
PY
        return 0
    fi

    warn "Could not convert WorkBuddy .icns icon; desktop entry will use theme icon name"
}

write_launcher() {
    cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/bash
set -euo pipefail

APP_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export CHROME_DESKTOP="${APP_ID}.desktop"
export ELECTRON_FORCE_IS_PACKAGED=1

# [wb-linux] Force Electron to use ayatana-appindicator (StatusNotifierItem)
# instead of its default GtkStatusIcon (X11 XEmbed). Wayland sessions and
# modern panels (waybar / quickshell DMS / KDE Plasma 6) only implement the
# SNI protocol; without "Unity" in XDG_CURRENT_DESKTOP, Electron registers
# the tray on a path no host listens to and the icon disappears completely.
# We only inject "Unity:" when it is not already present so users on Unity /
# GNOME with extensions / KDE keep their original desktop name intact.
if [ -z "\${XDG_CURRENT_DESKTOP:-}" ] || [[ ":\${XDG_CURRENT_DESKTOP:-}:" != *":Unity:"* ]]; then
  export XDG_CURRENT_DESKTOP="Unity:\${XDG_CURRENT_DESKTOP:-}"
fi

# [wb-linux] codebuddy CLI inside app.asar.unpacked waits up to 30s per
# stdio MCP server during settle; with N connectors enabled this stacks up
# and blocks the first LLM call for minutes if any one of them is slow to
# respond. 3s is enough for healthy local servers; the upstream
# Promise.race fallback still proceeds with whichever servers did connect.
export MCP_TIMEOUT="\${MCP_TIMEOUT:-3000}"
export MCP_TOOL_TIMEOUT="\${MCP_TOOL_TIMEOUT:-30000}"

ARGS=(
  --disable-dev-shm-usage
  --in-process-gpu
  --ozone-platform-hint=auto
  --enable-wayland-ime
)

if [ "\${WORKBUDDY_DISABLE_SANDBOX:-0}" = "1" ]; then
  ARGS+=(--no-sandbox --disable-gpu-sandbox)
fi

if [ "\${WORKBUDDY_LOCAL_MODE:-0}" = "1" ]; then
  exec "\$APP_DIR/resources/app.asar.unpacked/cli/bin/codebuddy" --serve --host 127.0.0.1 --port "\${WORKBUDDY_LOCAL_PORT:-7890}" --open
fi

exec "\$APP_DIR/workbuddy" "\${ARGS[@]}" "\$@"
EOF
    chmod +x "$INSTALL_DIR/start.sh"

    cat > "$INSTALL_DIR/start-local.sh" <<EOF
#!/bin/bash
set -euo pipefail

APP_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec "\$APP_DIR/resources/app.asar.unpacked/cli/bin/codebuddy" --serve --host 127.0.0.1 --port "\${WORKBUDDY_LOCAL_PORT:-7890}" --open
EOF
    chmod +x "$INSTALL_DIR/start-local.sh"
}

write_desktop_entry() {
    local icon_value="$APP_ID"
    if [ -f "$INSTALL_DIR/.workbuddy-linux/workbuddy.png" ]; then
        icon_value="$INSTALL_DIR/.workbuddy-linux/workbuddy.png"
    fi

    local desktop_name desktop_local_name desktop_exec desktop_local_exec desktop_icon
    desktop_name="$(desktop_value "$APP_DISPLAY_NAME")"
    desktop_local_name="$(desktop_value "$APP_DISPLAY_NAME Local")"
    desktop_exec="$(desktop_exec_path "$INSTALL_DIR/start.sh") %F"
    desktop_local_exec="$(desktop_exec_path "$INSTALL_DIR/start-local.sh")"
    desktop_icon="$(desktop_value "$icon_value")"

    mkdir -p "$INSTALL_DIR/.workbuddy-linux"
    cat > "$INSTALL_DIR/.workbuddy-linux/$APP_ID.desktop" <<EOF
[Desktop Entry]
Name=$desktop_name
Comment=Run WorkBuddy on Linux
Exec=$desktop_exec
Icon=$desktop_icon
Type=Application
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=WorkBuddy
MimeType=x-scheme-handler/workbuddy;
EOF

    cat > "$INSTALL_DIR/.workbuddy-linux/$APP_ID-local.desktop" <<EOF
[Desktop Entry]
Name=$desktop_local_name
Comment=Run WorkBuddy local CLI Web UI on Linux
Exec=$desktop_local_exec
Icon=$desktop_icon
Type=Application
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=WorkBuddy
EOF
}

register_desktop_entry() {
    local desktop_src="$INSTALL_DIR/.workbuddy-linux/$APP_ID.desktop"
    local desktop_dst="$HOME/.local/share/applications/$APP_ID.desktop"
    local icon_src="$INSTALL_DIR/.workbuddy-linux/workbuddy.png"
    local icon_dst="$HOME/.local/share/icons/hicolor/256x256/apps/$APP_ID.png"

    if [ ! -f "$desktop_src" ]; then
        warn "Desktop entry not found at $desktop_src; skipping registration"
        return 0
    fi

    mkdir -p "$HOME/.local/share/applications" \
             "$HOME/.local/share/icons/hicolor/256x256/apps"

    # Copy icon to XDG data dir for global accessibility
    if [ -f "$icon_src" ] && [ ! -f "$icon_dst" ]; then
        cp "$icon_src" "$icon_dst"
        chmod 0644 "$icon_dst"
    fi

    # Copy and register desktop entry to user's XDG applications dir
    cp "$desktop_src" "$desktop_dst"
    chmod 0644 "$desktop_dst"

    info "Registered desktop entry: $desktop_dst"

    # Update desktop database if available
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    # Update icon cache if available
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    fi
}

write_build_metadata() {
    local version="$1"
    local full_version="$2"
    mkdir -p "$INSTALL_DIR/.workbuddy-linux"
    cat > "$INSTALL_DIR/.workbuddy-linux/build-info.json" <<EOF
{
  "appId": "$APP_ID",
  "displayName": "$APP_DISPLAY_NAME",
  "upstreamVersion": "$version",
  "fullVersion": "$full_version",
  "electronVersion": "$ELECTRON_VERSION",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Patch the project-level package.json so its version field reflects the
# upstream DMG version (e.g. "5.0.3"). This keeps the repo's metadata in
# sync with whatever DMG the user built from. Also writes a .version file
# inside the app dir so packaging scripts can consume it without parsing
# package.json.
write_package_version() {
    local version="$1"
    local pkg_json="$SCRIPT_DIR/package.json"
    local app_version_file="$INSTALL_DIR/.workbuddy-linux/version"
    if [ -f "$pkg_json" ]; then
        if node - "$pkg_json" "$version" <<'NODE' 2>/dev/null; then
const fs = require('fs');
const [pkgPath, version] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
p.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');
NODE
            info "Updated package.json version to $version" || \
            warn "Failed to update package.json version to $version"
        fi
    fi
    echo -n "$version" > "$app_version_file"
}

main() {
    parse_args "$@"
    check_deps
    validate_app_identity

    local input_path app_bundle upstream_version
    input_path="$(resolve_input_path "$PROVIDED_INPUT")"
    app_bundle="$(resolve_app_bundle "$input_path")"
    ELECTRON_VERSION="$(detect_electron_version "$app_bundle")"
    upstream_version="$(read_app_version "$app_bundle")"
    local full_version
    full_version="$(read_app_full_version "$app_bundle")"

    info "Using app bundle: $app_bundle"
    info "Using Electron: $ELECTRON_VERSION"
    info "Upstream version: $upstream_version (full: $full_version)"

    # Export for downstream packaging scripts
    export PACKAGE_VERSION="${full_version:-${upstream_version:-$(date -u +%Y.%m.%d.%H%M%S)}}"

    prepare_install_dir
    download_electron_runtime
    copy_app_payload "$app_bundle"

    # Rebuild native modules in app.asar.unpacked (where the .node files live)
    local native_dir="$INSTALL_DIR/resources/app.asar.unpacked"
    local lydell_platform_package
    lydell_platform_package="$(lydell_node_pty_linux_package 2>/dev/null || true)"

    if [ -d "$native_dir/node_modules" ]; then
        rebuild_native_modules "$native_dir"
    elif [ -d "$INSTALL_DIR/resources/app/node_modules" ]; then
        rebuild_native_modules "$INSTALL_DIR/resources/app"
    fi

    # Apply Linux-specific runtime patches inside app.asar so the main
    # window actually opens and the tray right-click menu is populated.
    # Directory-mode payloads are preserved for older experiments; they do
    # not have an app.asar to repack, so the asar-only patcher is skipped.
    if [ -f "$INSTALL_DIR/resources/app.asar" ]; then
        apply_linux_runtime_patches "$INSTALL_DIR" "$lydell_platform_package"
    else
        warn "Skipping app.asar Linux runtime patches for directory-mode payload"
    fi

    write_icon "$app_bundle"
    write_launcher
    write_desktop_entry
    register_desktop_entry
    write_package_version "$upstream_version"
    write_build_metadata "$upstream_version" "$full_version"

    info "Build complete: $INSTALL_DIR"
    info "Run: $INSTALL_DIR/start.sh"
}

trap 'rm -rf "$WORK_DIR"' EXIT
main "$@"
