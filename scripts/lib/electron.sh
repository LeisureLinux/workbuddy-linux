#!/bin/bash
# Linux Electron runtime download. Sourced by install.sh.

electron_arch() {
    case "$ARCH" in
        x86_64) echo "x64" ;;
        aarch64) echo "arm64" ;;
        armv7l) echo "armv7l" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac
}

download_electron_runtime() {
    local arch zip_name url cache_dir cached_zip partial_zip lock_dir checksum

    arch="$(electron_arch)"
    zip_name="electron-v${ELECTRON_VERSION}-linux-${arch}.zip"
    if [ -n "$ELECTRON_MIRROR" ]; then
        url="${ELECTRON_MIRROR%/}/v${ELECTRON_VERSION}/${zip_name}"
    else
        url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zip_name}"
    fi

    cache_dir="${WORKBUDDY_ELECTRON_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/workbuddy-linux/electron}"
    cached_zip="$cache_dir/$zip_name"
    partial_zip="$cached_zip.$$.$RANDOM.part"
    lock_dir="$cache_dir/$zip_name.lock"
    checksum="${ELECTRON_ZIP_SHA256:-}"
    mkdir -p "$cache_dir"

    while ! mkdir "$lock_dir" 2>/dev/null; do
        info "Waiting for Electron cache lock: $zip_name"
        sleep 1
    done
    trap "rm -rf '$lock_dir'" RETURN

    if [ ! -f "$cached_zip" ]; then
        info "Downloading $zip_name"
        curl -L --fail --progress-bar -o "$partial_zip" "$url"
        if [ -n "$checksum" ]; then
            printf '%s  %s\n' "$checksum" "$partial_zip" | sha256sum -c - >/dev/null || error "Electron runtime checksum mismatch: $zip_name"
        fi
        mv "$partial_zip" "$cached_zip"
    else
        info "Using cached Electron runtime: $cached_zip"
    fi

    if [ -n "$checksum" ]; then
        printf '%s  %s\n' "$checksum" "$cached_zip" | sha256sum -c - >/dev/null || error "Cached Electron runtime checksum mismatch: $zip_name"
    fi

    unzip -qo "$cached_zip" -d "$INSTALL_DIR"
    if [ ! -e "$INSTALL_DIR/electron" ]; then
        error "Electron binary was not extracted (expected at $INSTALL_DIR/electron)"
    fi
    # Rename the Electron artifact to the project name so the installed
    # tree is uniformly named after the application, not the framework.
    # Keep a symlink named `electron` so any process-title / argv[0]
    # logic that hard-codes the framework name still resolves to the
    # same executable.
    if [ ! -e "$INSTALL_DIR/workbuddy" ]; then
        mv "$INSTALL_DIR/electron" "$INSTALL_DIR/workbuddy"
        ln -s workbuddy "$INSTALL_DIR/electron"
    fi
    rm -rf "$lock_dir"
    trap - RETURN
}
