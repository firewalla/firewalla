#!/bin/bash

# no apt download retries: over the archive's plain HTTP, a redirected and retried download can
# overwrite a package apt has already verified

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

TAG="FIREWALLA:APT_NO_RETRIES"
CONF=/etc/apt/apt.conf.d/99firewalla-no-retries
SETTING='Acquire::Retries "0";'

# the lower root keeps it across a reboot on a tmpfs root, and is what apt-get.sh's
# overlayroot-chroot install reads. checked by its lower path: a lookup through / first could
# leave the overlay caching the name as missing
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
