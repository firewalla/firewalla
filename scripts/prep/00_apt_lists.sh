#!/bin/bash

# keeps what apt update writes to /log small: lists stay compressed, no translations, and no source
# or -proposed indexes, which some images enable

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

TAG="FIREWALLA:APT_LISTS"
CONF=/etc/apt/apt.conf.d/99firewalla-lists
SETTING='Acquire::GzipIndexes "true";
Acquire::Languages "none";'
LIST=/etc/apt/sources.list

# the lower root keeps it across a reboot on a tmpfs root. checked by its lower path: a lookup
# through / first could leave the overlay caching the name as missing
if [[ "$RAMFS_ROOT_PARTITION" == "yes" && "$(cat /media/root-ro$CONF 2>/dev/null)" != "$SETTING" ]]; then
  if echo "$SETTING" | sudo overlayroot-chroot tee $CONF >/dev/null; then
    logger "$TAG:LOWER_WRITTEN"
  else
    logger "$TAG:ERROR:LOWER_WRITE_FAILED"
  fi
fi

# overlayfs does not promise to show a file added to the lower root while mounted
if [[ "$(cat $CONF 2>/dev/null)" != "$SETTING" ]]; then
  if echo "$SETTING" | sudo tee $CONF >/dev/null; then
    logger "$TAG:WRITTEN"
  else
    logger "$TAG:ERROR:WRITE_FAILED"
  fi
fi

# only the live root, so the image keeps its own copy; the chroot install in apt-get.sh runs no
# update. commented out rather than deleted, so the box still shows what the image enabled
if grep -qE '^\s*(deb-src\s|deb\s+\S+\s+\S+-proposed\s)' $LIST 2>/dev/null; then
  if sudo sed -i -E 's/^\s*(deb-src\s|deb\s+\S+\s+\S+-proposed\s)/# &/' $LIST; then
    logger "$TAG:SOURCES_TRIMMED"
  else
    logger "$TAG:ERROR:SOURCES_TRIM_FAILED"
  fi
fi
