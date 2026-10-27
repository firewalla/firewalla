#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

# downloaded by update_assets.sh from fireupgrade /all/ca-certificates_all.deb, see platform/all/files/assets.lst
ASSET_DEB="${FIREWALLA_HIDDEN}/run/assets/ca-certificates_all.deb"
# shipped with the release, used as the floor when the asset is missing, invalid or older
BUNDLED_DEB="${FIREWALLA_HOME}/platform/all/files/cacert/ca-certificates_all.deb"

log() {
  logger -t firewalla "update_ca_certificates: $*"
}

# serialize runs from main-run, update_assets.sh exec_post and cron, concurrent dpkg -i would fail on the dpkg lock
exec 200<"$0"
if ! flock -w 300 200; then
  log "timed out waiting for another instance, skip"
  exit 1
fi

# prints the Version of a ca-certificates deb, fails if the file is missing, unreadable or not ca-certificates
deb_version() {
  [[ -f "$1" ]] || return 1
  [[ "$(dpkg-deb -f "$1" Package 2>/dev/null)" == "ca-certificates" ]] || return 1
  local version
  version=$(dpkg-deb -f "$1" Version 2>/dev/null)
  [[ -n "$version" ]] || return 1
  echo "$version"
}

# prints the installed version, nothing if not installed or left unconfigured by a failed install
installed_version() {
  local status
  status=$(dpkg-query -W -f='${db:Status-Status} ${Version}' ca-certificates 2>/dev/null)
  [[ "$status" == "installed "* ]] && echo "${status#installed }"
}

ASSET_VERSION=$(deb_version "$ASSET_DEB")
if [[ -z "$ASSET_VERSION" && -f "$ASSET_DEB" ]]; then
  log "WARN invalid asset deb, ignored: $ASSET_DEB"
fi
BUNDLED_VERSION=$(deb_version "$BUNDLED_DEB")
if [[ -z "$BUNDLED_VERSION" ]]; then
  log "WARN bundled deb not found or invalid: $BUNDLED_DEB"
fi

# try the newer deb first, the other one is the fallback if installing the newer one fails
CANDIDATES=()
if [[ -n "$ASSET_VERSION" ]] && { [[ -z "$BUNDLED_VERSION" ]] || dpkg --compare-versions "$ASSET_VERSION" ge "$BUNDLED_VERSION"; }; then
  CANDIDATES=("asset|$ASSET_VERSION|$ASSET_DEB")
  [[ -n "$BUNDLED_VERSION" ]] && CANDIDATES+=("bundled|$BUNDLED_VERSION|$BUNDLED_DEB")
elif [[ -n "$BUNDLED_VERSION" ]]; then
  CANDIDATES=("bundled|$BUNDLED_VERSION|$BUNDLED_DEB")
  [[ -n "$ASSET_VERSION" ]] && CANDIDATES+=("asset|$ASSET_VERSION|$ASSET_DEB")
fi

RESULT=0
for CANDIDATE in "${CANDIDATES[@]}"; do
  SOURCE=${CANDIDATE%%|*}
  DEB_FILE=${CANDIDATE##*|}
  TARGET_VERSION=${CANDIDATE#*|}
  TARGET_VERSION=${TARGET_VERSION%%|*}

  INSTALLED_VERSION=$(installed_version)
  # only upgrade when ca-certificates is missing or installed version is older
  if [[ -n "$INSTALLED_VERSION" ]] && ! dpkg --compare-versions "$INSTALLED_VERSION" lt "$TARGET_VERSION"; then
    exit $RESULT
  fi

  if OUTPUT=$(sudo dpkg -i "$DEB_FILE" 2>&1); then
    log "upgraded ca-certificates from ${INSTALLED_VERSION:-none} to $TARGET_VERSION (source: $SOURCE)"
    exit 0
  fi
  log "ERROR failed to upgrade ca-certificates to $TARGET_VERSION (source: $SOURCE): $(echo "$OUTPUT" | tail -n 5 | tr '\n' ' ')"
  RESULT=1
done

exit $RESULT
