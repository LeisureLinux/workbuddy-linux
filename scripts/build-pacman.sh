#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
PKG_WORK="${PKG_WORK:-$DIST_DIR/pacman-work}"
PACKAGE_NAME="${PACKAGE_NAME:-workbuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(resolve_package_version)}"
PACMAN_VERSION="${PACKAGE_VERSION//+/_}"
PACMAN_VERSION="${PACMAN_VERSION//-/_}"
MAINTAINER="${MAINTAINER:-LeisureLinux <AlbertXu@FreeLAMP.com>}"
HOMEPAGE="${HOMEPAGE:-https://workbuddy.cn/}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"

map_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        *) error "Unsupported pacman architecture: $(uname -m)" ;;
    esac
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run make build-app first."
    require_cmd tar

    local arch output_file pkgdir
    arch="$(map_arch)"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${PACMAN_VERSION}-1-${arch}.pkg.tar.zst"
    pkgdir="$PKG_WORK/pkg/$PACKAGE_NAME"

    rm -rf "$PKG_WORK"
    mkdir -p \
        "$pkgdir/opt/$PACKAGE_NAME" \
        "$pkgdir/usr/bin" \
        "$pkgdir/usr/share/applications" \
        "$pkgdir/usr/share/icons/hicolor/256x256/apps"

    cp -a "$APP_DIR/." "$pkgdir/opt/$PACKAGE_NAME/"
    sanitize_package_tree "$pkgdir"

    sed -e "s|__EXEC__|/opt/$PACKAGE_NAME/start.sh %F|g" "$DESKTOP_TEMPLATE" \
        > "$pkgdir/usr/share/applications/$PACKAGE_NAME.desktop"
    chmod 0644 "$pkgdir/usr/share/applications/$PACKAGE_NAME.desktop"

    cat > "$pkgdir/usr/bin/$PACKAGE_NAME" <<EOF
#!/bin/bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
EOF
    chmod 0755 "$pkgdir/usr/bin/$PACKAGE_NAME"

    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$pkgdir/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
        chmod 0644 "$pkgdir/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    if [ -f "$pkgdir/opt/$PACKAGE_NAME/chrome-sandbox" ]; then
        chmod 4755 "$pkgdir/opt/$PACKAGE_NAME/chrome-sandbox"
    fi

    local installed_size
    installed_size="$(du -sk "$pkgdir" | awk '{print $1}')"
    cat > "$pkgdir/.PKGINFO" <<EOF
pkgname = $PACKAGE_NAME
pkgbase = $PACKAGE_NAME
pkgver = $PACMAN_VERSION-1
pkgdesc = Unofficial local Linux conversion of WorkBuddy
url = $HOMEPAGE
builddate = $(date -u +%s)
packager = $MAINTAINER
size = $installed_size
arch = $arch
license = MIT
depend = gtk3
depend = nss
depend = libxss
depend = alsa-lib
depend = libsecret
depend = libxkbfile
EOF

    mkdir -p "$DIST_DIR"
    rm -f "$output_file"
    if tar --help 2>/dev/null | grep -q -- '--zstd'; then
        tar --zstd --owner=0 --group=0 -C "$pkgdir" -cf "$output_file" .
    else
        require_cmd zstd
        tar --owner=0 --group=0 -C "$pkgdir" -cf - . | zstd -T0 -19 -o "$output_file"
    fi
    [ -f "$output_file" ] || error "pacman package was not produced"
    info "Built package: $output_file"
}

main "$@"
