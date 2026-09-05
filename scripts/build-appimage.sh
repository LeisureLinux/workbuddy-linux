#!/bin/bash
set -Eeuo pipefail
# Build a portable AppImage from a previously built workbuddy-app/ directory.
#
# Usage:
#   make build-app                  # build workbuddy-app/ first
#   bash scripts/build-appimage.sh  # produce dist/WorkBuddy-*.AppImage
#
# Environment:
#   PACKAGE_VERSION     Version string (default: YYYY.MM.DD.HHMMSS)
#   PACKAGE_NAME        Application slug (default: WorkBuddy)
#   APPIMAGETOOL_URL    Custom appimagetool download URL (default: GitHub release)
#   APPIMAGETOOL_SHA256 Expected SHA256 checksum for downloaded appimagetool
#   ARCH                Target architecture (default: auto-detect from uname -m)
#
# Dependencies at build time:
#   - appimagetool (auto-downloaded to .cache/appimagetool if not in PATH)
#   - fuse2 / fuse3 (for running AppImage; not needed for building on modern Linux)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
CACHE_DIR="${CACHE_DIR:-$REPO_DIR/.cache}"
PACKAGE_NAME="${PACKAGE_NAME:-WorkBuddy}"
APP_ID="${APP_ID:-workbuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(resolve_package_version)}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"

map_arch() {
    case "${ARCH:-$(uname -m)}" in
        x86_64|amd64) echo "x86_64" ;;
        aarch64|arm64) echo "aarch64" ;;
        *) error "Unsupported AppImage architecture: ${ARCH:-$(uname -m)}" ;;
    esac
}

# Download appimagetool if not available in PATH or cache.
resolve_appimagetool() {
    if command -v appimagetool >/dev/null 2>&1; then
        command -v appimagetool
        return 0
    fi

    local arch cache_dir tool_path
    arch="$(map_arch)"
    cache_dir="$CACHE_DIR/appimagetool"
    tool_path="$cache_dir/appimagetool-$arch"

    if [ -x "$tool_path" ]; then
        if [ -n "${APPIMAGETOOL_SHA256:-}" ]; then
            printf '%s  %s\n' "$APPIMAGETOOL_SHA256" "$tool_path" | sha256sum -c - >/dev/null || error "Cached appimagetool checksum mismatch: $tool_path"
        fi
        echo "$tool_path"
        return 0
    fi

    local url
    case "$arch" in
        x86_64) url="${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage}" ;;
        aarch64) url="${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-aarch64.AppImage}" ;;
    esac

    info "Downloading appimagetool for $arch ..."
    mkdir -p "$cache_dir"
    curl -fsSL -o "$tool_path" "$url" || error "Failed to download appimagetool from $url"
    if [ -n "${APPIMAGETOOL_SHA256:-}" ]; then
        printf '%s  %s\n' "$APPIMAGETOOL_SHA256" "$tool_path" | sha256sum -c - >/dev/null || error "appimagetool checksum mismatch: $tool_path"
    else
        warn "APPIMAGETOOL_SHA256 is not set; downloaded appimagetool cannot be verified"
    fi
    chmod +x "$tool_path"
    echo "$tool_path"
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run make build-app first."

    local arch output_file appdir_path
    arch="$(map_arch)"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${PACKAGE_VERSION}-${arch}.AppImage"
    appdir_path="$DIST_DIR/AppDir"

    # Clean and re-create AppDir
    rm -rf "$appdir_path"
    mkdir -p \
        "$appdir_path/opt/$APP_ID" \
        "$appdir_path/usr/bin" \
        "$appdir_path/usr/share/applications" \
        "$appdir_path/usr/share/icons/hicolor/256x256/apps"

    # ---------------------------------------------------------------
    # 1. Copy app payload
    # ---------------------------------------------------------------
    info "Copying app payload into AppDir ..."
    cp -a "$APP_DIR/." "$appdir_path/opt/$APP_ID/"
    sanitize_package_tree "$appdir_path"

    # ---------------------------------------------------------------
    # 2. Generate AppRun entry point
    # ---------------------------------------------------------------
    cat > "$appdir_path/AppRun" <<'APPRUN'
#!/bin/bash
set -euo pipefail

# ---- AppImage metadata ----
APPDIR="$(dirname "$(readlink -f "$0")")"
export APPIMAGE="${APPIMAGE:-}"
export APPDIR="${APPDIR:-}"

# ---- App-specific exports (same as start.sh) ----
export CHROME_DESKTOP="workbuddy.desktop"
export ELECTRON_FORCE_IS_PACKAGED=1
export XDG_CURRENT_DESKTOP="Unity:${XDG_CURRENT_DESKTOP:-}"
export MCP_TIMEOUT="${MCP_TIMEOUT:-3000}"
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-30000}"
# Avoid double-dipping into sidecar re-direct when launched through AppImage
unset ELECTRON_RUN_AS_NODE

# ---- Desktop entry registration ----
# When launched as an AppImage, register/unregister the desktop entry to
# ~/.local/share/applications/ so the app appears in the system launcher
# (GNOME Shell, KDE Plasma, etc.) with correct name, icon and launcher path.
REGISTER_DESKTOP="${WORKBUDDY_REGISTER_DESKTOP:-1}"
if [ "${REGISTER_DESKTOP}" = "1" ] && [ -n "${APPIMAGE:-}" ]; then
  APPIMAGE_PATH="$(readlink -f "$APPIMAGE")"
  APPIMAGE_NAME="${APPIMAGE_PATH##*/}"
  DESKTOP_FILE="$HOME/.local/share/applications/workbuddy.desktop"
  ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
  ICON_FILE="$ICON_DIR/workbuddy.png"
  REG_MARKER="$HOME/.local/share/applications/.workbuddy-registered"

  register_desktop=0
  if [ ! -f "$DESKTOP_FILE" ]; then
    register_desktop=1
  elif [ -f "$REG_MARKER" ]; then
    stored_path="$(cat "$REG_MARKER" 2>/dev/null || true)"
    if [ "$stored_path" != "$APPIMAGE_PATH" ]; then
      register_desktop=1
    fi
  else
    register_desktop=1
  fi

  if [ "$register_desktop" = "1" ]; then
    mkdir -p "$HOME/.local/share/applications" "$ICON_DIR"

    # Copy icon if available
    if [ -f "$APPDIR/usr/share/icons/hicolor/256x256/apps/workbuddy.png" ]; then
      cp "$APPDIR/usr/share/icons/hicolor/256x256/apps/workbuddy.png" "$ICON_FILE"
    elif [ -f "$APPDIR/workbuddy.png" ]; then
      cp "$APPDIR/workbuddy.png" "$ICON_FILE"
    fi

    # Write .desktop entry (freedesktop.org compliant)
    cat > "$DESKTOP_FILE" <<DESKTOP_EOF
[Desktop Entry]
Name=WorkBuddy
Comment=AI Agent Desktop Application
Exec="${APPIMAGE_PATH}" %F
Icon=${ICON_FILE}
Type=Application
Categories=Development;IDE;
StartupNotify=true
StartupWMClass=WorkBuddy
MimeType=x-scheme-handler/workbuddy;
DESKTOP_EOF

    chmod 0644 "$DESKTOP_FILE"
    echo "$APPIMAGE_PATH" > "$REG_MARKER"
    chmod 0644 "$REG_MARKER"

    # Update desktop database if available
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    # Update icon cache if available
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
      gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    fi
  fi
fi

# ---- Ozone / Wayland hints ----
ARGS=(
  --disable-dev-shm-usage
  --in-process-gpu
  --ozone-platform-hint=auto
  --enable-wayland-ime
)

# ---- AppImage cannot use setuid chrome-sandbox (FUSE) ----
if [ "${WORKBUDDY_DISABLE_SANDBOX:-0}" = "1" ] || [ -n "${APPIMAGE:-}" ]; then
  ARGS+=(--no-sandbox --disable-gpu-sandbox)
fi

# ---- Launch Electron ----
exec "$APPDIR/opt/workbuddy/workbuddy" "${ARGS[@]}" "$@"
APPRUN
    chmod 0755 "$appdir_path/AppRun"

    # ---------------------------------------------------------------
    # 3. Desktop entry
    # ---------------------------------------------------------------
    sed -e "s|__EXEC__|opt/workbuddy/start.sh %F|g" "$DESKTOP_TEMPLATE" \
        > "$appdir_path/usr/share/applications/$APP_ID.desktop"
    chmod 0644 "$appdir_path/usr/share/applications/$APP_ID.desktop"
    # Also link root-level .desktop for appimagetool discovery
    cp -a "$appdir_path/usr/share/applications/$APP_ID.desktop" "$appdir_path/$APP_ID.desktop"

    # ---------------------------------------------------------------
    # 4. Icon
    # ---------------------------------------------------------------
    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$appdir_path/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
        chmod 0644 "$appdir_path/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
        cp -a "$appdir_path/usr/share/icons/hicolor/256x256/apps/workbuddy.png" "$appdir_path/workbuddy.png"
    fi
    # .DirIcon is required by the AppImage spec
    if [ -f "$appdir_path/workbuddy.png" ]; then
        cp "$appdir_path/workbuddy.png" "$appdir_path/.DirIcon"
    fi

    # ---------------------------------------------------------------
    # 5. Sanity check against the AppDir spec
    # ---------------------------------------------------------------
    [ -f "$appdir_path/AppRun" ] || error "AppDir missing AppRun"
    [ -f "$appdir_path/$APP_ID.desktop" ] || error "AppDir missing .desktop entry"
    if [ ! -f "$appdir_path/.DirIcon" ] && [ ! -f "$appdir_path/workbuddy.png" ]; then
        warn "No PNG icon found; appimagetool may embed a placeholder"
    fi

    # ---------------------------------------------------------------
    # 6. Build the AppImage
    # ---------------------------------------------------------------
    local appimagetool
    appimagetool="$(resolve_appimagetool)"
    info "Building AppImage with $appimagetool ..."
    mkdir -p "$DIST_DIR"
    rm -f "$output_file"
    # appimagetool is itself an AppImage; on systems without FUSE it may
    # fail at first. APPIMAGE_EXTRACT_AND_RUN=1 tells it to self-extract
    # to a temp dir instead of using FUSE mount, which works everywhere.
    # appimagetool exits 0 even on warnings; capture stderr for diagnostics.
    set +e
    APPIMAGE_EXTRACT_AND_RUN=1 \
    "$appimagetool" \
        --no-appstream \
        "$appdir_path" "$output_file" 2>&1 | \
        grep -v "WARNING:.*updateinfo\|WARNING:.*appstream\|AppStream\|updateinformation"
    local appimagetool_status="${PIPESTATUS[0]}"
    set -e

    [ "$appimagetool_status" -eq 0 ] || error "appimagetool failed with exit code $appimagetool_status"

    if [ -s "$output_file" ]; then
        chmod 0755 "$output_file"
        info "Built AppImage: $output_file ($(du -h "$output_file" | cut -f1))"
    else
        error "appimagetool did not produce an output file"
    fi

    # Clean up
    rm -rf "$appdir_path"
}

main "$@"
