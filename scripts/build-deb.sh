#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
PKG_ROOT="${PKG_ROOT:-$DIST_DIR/deb-root}"
PACKAGE_NAME="${PACKAGE_NAME:-workbuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(resolve_package_version)}"
MAINTAINER="${MAINTAINER:-LeisureLinux <AlbertXu@FreeLAMP.com>}"
HOMEPAGE="${HOMEPAGE:-https://workbuddy.cn/}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"
CONTROL_TEMPLATE="$REPO_DIR/packaging/linux/control"

map_arch() {
    case "$(dpkg --print-architecture)" in
        amd64|arm64|armhf) dpkg --print-architecture ;;
        *) error "Unsupported Debian architecture: $(dpkg --print-architecture)" ;;
    esac
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run ./install.sh first."
    require_cmd dpkg
    require_cmd dpkg-deb

    local arch output_file
    arch="$(map_arch)"
    output_file="$DIST_DIR/${PACKAGE_NAME}_${PACKAGE_VERSION}_${arch}.deb"

    rm -rf "$PKG_ROOT"
    mkdir -p \
        "$PKG_ROOT/DEBIAN" \
        "$PKG_ROOT/opt/$PACKAGE_NAME" \
        "$PKG_ROOT/usr/bin" \
        "$PKG_ROOT/usr/share/applications" \
        "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps"

    cp -a "$APP_DIR/." "$PKG_ROOT/opt/$PACKAGE_NAME/"
    sanitize_package_tree "$PKG_ROOT"

    # Set SUID bit on chrome-sandbox so Chromium can spawn child processes
    if [ -f "$PKG_ROOT/opt/$PACKAGE_NAME/chrome-sandbox" ]; then
        chmod 4755 "$PKG_ROOT/opt/$PACKAGE_NAME/chrome-sandbox"
    fi

    cat > "$PKG_ROOT/usr/bin/$PACKAGE_NAME" <<EOF
#!/bin/bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
EOF
    chmod 0755 "$PKG_ROOT/usr/bin/$PACKAGE_NAME"

    sed -e "s|__EXEC__|/opt/$PACKAGE_NAME/start.sh %F|g" "$DESKTOP_TEMPLATE" \
        > "$PKG_ROOT/usr/share/applications/$PACKAGE_NAME.desktop"
    chmod 0644 "$PKG_ROOT/usr/share/applications/$PACKAGE_NAME.desktop"

    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
        chmod 0644 "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    sed \
        -e "s/__PACKAGE_NAME__/$PACKAGE_NAME/g" \
        -e "s/__VERSION__/$PACKAGE_VERSION/g" \
        -e "s/__ARCH__/$arch/g" \
        -e "s|__MAINTAINER__|$MAINTAINER|g" \
        -e "s|__HOMEPAGE__|$HOMEPAGE|g" \
        -e "s|__DOWNLOAD_HOMEPAGE__|$HOMEPAGE|g" \
        "$CONTROL_TEMPLATE" > "$PKG_ROOT/DEBIAN/control"
    chmod 0644 "$PKG_ROOT/DEBIAN/control"

    mkdir -p "$DIST_DIR"
    dpkg-deb --root-owner-group --build "$PKG_ROOT" "$output_file" >&2
    info "Built package: $output_file"
}

main "$@"
