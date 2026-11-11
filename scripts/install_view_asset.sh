#!/bin/bash

: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

# usage: install_view_asset.sh <name>
# extracts the mini web view <name>.tar.gz, which api/app.js serves in preference to the
# bundle shipped in api/public/<name>/

# called from assets.lst exec_post after a download, and from FireApi at startup: update_assets.sh
# runs exec_post only when the tarball changed, so an extraction that failed or was interrupted is
# never retried. it installs whatever is there rather than deciding whether the view looks
# complete, since nothing on disk tells a finished extraction from one cut short

NAME="$1"
VIEWS_DIR="${FIREWALLA_HIDDEN}/run/assets/views"
TARBALL="$VIEWS_DIR/$NAME.tar.gz"

log() {
  echo "$*"
  logger -t firewalla "install_view_asset: $*"
}

if [[ -z "$NAME" ]]; then
  echo "usage: $(basename "$0") <view name>"
  exit 1
fi

if [[ ! -f "$TARBALL" ]]; then
  log "$TARBALL does not exist"
  exit 1
fi

# a box that got this directory from an older update_assets.sh has it owned by root, and
# every extraction into it fails with EPERM until that is corrected
[[ -w "$VIEWS_DIR" ]] || sudo install -d -o pi -g pi "$VIEWS_DIR" || exit 1

# the asset download and FireApi's startup check both run shortly after a boot
exec 200<"$0"
if ! flock -w 60 200; then
  log "timed out waiting for another instance, skip"
  exit 1
fi

cd "$VIEWS_DIR" || exit 1

# unpacked beside the view and swapped in, so FireApi never serves a half extracted view and a
# tarball that is damaged or packaged wrong leaves the one that works in place
STAGING=".$NAME.new"
OLD=".$NAME.old"
rm -rf "$STAGING" "$OLD"
if ! { mkdir -p "$STAGING" && tar -xzf "$NAME.tar.gz" -C "$STAGING" --strip-components=1; }; then
  log "failed to extract $TARBALL"
  rm -rf "$STAGING"
  exit 1
fi
if [[ ! -f "$STAGING/index.html" ]]; then
  log "$TARBALL holds no index.html, keeping the installed $NAME"
  rm -rf "$STAGING"
  exit 1
fi

# FireApi installs on every start, so most runs extract what is already there. swapping anyway
# would let a request fall between the two renames below and 404 on a hashed file
if diff -qr "$STAGING" "$NAME" >/dev/null 2>&1; then
  rm -rf "$STAGING"
  exit 0
fi

[[ -d "$NAME" ]] && mv "$NAME" "$OLD"
if ! mv "$STAGING" "$NAME"; then
  log "failed to install $NAME"
  [[ -d "$OLD" ]] && mv "$OLD" "$NAME"
  exit 1
fi
rm -rf "$OLD"
log "installed $NAME"
