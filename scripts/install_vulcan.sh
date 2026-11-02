#!/bin/bash
#
# Installs vulcan.service and starts vulcan once its asset binary is present.
#
# Called from two places:
# - scripts/prep/20_add_vulcan.sh on every boot: the root filesystem is reset at
#   boot on most platforms, so the unit has to be installed again each time
# - the vulcan entry of assets.lst, with "restart", after a new binary is downloaded
#
# Idempotent: the unit is only copied when it differs, and vulcan is only
# (re)started when asked to, when the unit changed, or when it is not running.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

VULCAN_BIN=/home/pi/.firewalla/run/assets/vulcan
UNIT=vulcan.service

# before the first download, the assets.lst post-hook calls this again later
[[ -x $VULCAN_BIN ]] || exit 0

unit_changed=""
if ! cmp -s "$FIREWALLA_HOME/etc/$UNIT" "/etc/systemd/system/$UNIT"; then
  sudo cp "$FIREWALLA_HOME/etc/$UNIT" "/etc/systemd/system/$UNIT"
  sudo systemctl daemon-reload
  unit_changed=1
fi

if [[ $1 == "restart" || -n $unit_changed ]]; then
  sudo systemctl restart vulcan
elif ! systemctl -q is-active vulcan; then
  sudo systemctl start vulcan
fi

exit 0
