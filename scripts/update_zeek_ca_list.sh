#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

# usage: update_zeek_ca_list.sh [--restart]
# installs the zeek CA list, --restart also restarts a running brofish when the installed list changed

# downloaded by update_assets.sh from fireupgrade /all/mozilla-ca-list.zeek, see platform/all/files/assets.lst
ASSET_LIST="${FIREWALLA_HIDDEN}/run/assets/mozilla-ca-list.zeek"
# shipped with the release, used when the asset is missing
BUNDLED_LIST="${FIREWALLA_HOME}/platform/all/hooks/before_bro/mozilla-ca-list.zeek"
ZEEK_CA_LIST=/usr/local/zeek/share/zeek/base/protocols/ssl/mozilla-ca-list.zeek

log() {
  logger -t firewalla "update_zeek_ca_list: $*"
}

# zeek is not installed
[[ -e $ZEEK_CA_LIST ]] || exit 0

# serialize the before_bro hook and the asset exec_post, which main-run can run at the same time
exec 200<"$0"
if ! flock -w 60 200; then
  log "timed out waiting for another instance, skip"
  exit 1
fi

SOURCE=$BUNDLED_LIST
[[ -f "$ASSET_LIST" ]] && SOURCE=$ASSET_LIST

cmp -s "$SOURCE" "$ZEEK_CA_LIST" && exit 0

# replaced with mv so a zeek starting meanwhile never reads a partial file
sudo cp "$SOURCE" "$ZEEK_CA_LIST.tmp" && sudo mv "$ZEEK_CA_LIST.tmp" "$ZEEK_CA_LIST" || exit 1
log "installed $SOURCE"

# activating too: bro-run may have read the old list before this install
if [[ "$1" == "--restart" ]] && [[ $(systemctl is-active brofish) =~ ^(active|activating)$ ]]; then
  log "restarting brofish to load the new CA list"
  sudo systemctl restart --no-block brofish
fi
