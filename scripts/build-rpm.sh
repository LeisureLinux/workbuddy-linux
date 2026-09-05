#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
PKG_ROOT="${PKG_ROOT:-$DIST_DIR/rpm-root}"
PACKAGE_NAME="${PACKAGE_NAME:-workbuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(resolve_package_version)}"
RPM_VERSION="${PACKAGE_VERSION//+/_}"
RPM_VERSION="${RPM_VERSION//-/_}"
MAINTAINER_NAME="${MAINTAINER_NAME:-LeisureLinux}"
HOMEPAGE="${HOMEPAGE:-https://workbuddy.cn/}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"
SPEC_FILE="$DIST_DIR/$PACKAGE_NAME.spec"

map_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        *) error "Unsupported RPM architecture: $(uname -m)" ;;
    esac
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run make build-app first."
    require_cmd rpmbuild

    local arch output_dir output_file
    arch="$(map_arch)"
    output_dir="$DIST_DIR/rpmbuild"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${RPM_VERSION}-1.${arch}.rpm"

    rm -rf "$PKG_ROOT" "$output_dir"
    mkdir -p \
        "$PKG_ROOT/opt/$PACKAGE_NAME" \
        "$PKG_ROOT/usr/bin" \
        "$PKG_ROOT/usr/share/applications" \
        "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps" \
        "$output_dir/BUILD" "$output_dir/RPMS" "$output_dir/SOURCES" "$output_dir/SPECS" "$output_dir/SRPMS"

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

    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    local icon_files_entry=""
    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        icon_files_entry="/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    cat > "$SPEC_FILE" <<EOF
Name: $PACKAGE_NAME
Version: $RPM_VERSION
Release: 1%{?dist}
Summary: Unofficial local Linux conversion of WorkBuddy
License: MIT
URL: $HOMEPAGE
BuildArch: $arch
Requires: gtk3, nss, libXScrnSaver, alsa-lib, libsecret, libxkbfile

%description
This package is generated locally from a user-owned official WorkBuddy
macOS copy. It does not redistribute upstream software through the source
repository.

Download the official WorkBuddy macOS DMG from:
$HOMEPAGE

%install
mkdir -p %{buildroot}
cp -a $PKG_ROOT/. %{buildroot}/

%files
/opt/$PACKAGE_NAME
/usr/bin/$PACKAGE_NAME
/usr/share/applications/$PACKAGE_NAME.desktop
$icon_files_entry
EOF

    # Packager is only valid in the local rpmbuild invocation, not in the
    # rendered spec. Inject it via --define so users can override it
    # without editing the spec template.
    RPMBUILD_DEFINES=(--define "_topdir $output_dir" --define "_build_id_links none")
    if [ -n "$MAINTAINER_NAME" ]; then
        RPMBUILD_DEFINES+=(--define "packager $MAINTAINER_NAME")
    fi

    rpmbuild "${RPMBUILD_DEFINES[@]}" -bb "$SPEC_FILE" >&2
    mkdir -p "$DIST_DIR"
    find "$output_dir/RPMS" -type f -name "*.rpm" -exec cp {} "$output_file" \;
    [ -f "$output_file" ] || error "RPM was not produced"
    info "Built package: $output_file"
}

main "$@"
