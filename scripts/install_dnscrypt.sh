#!/bin/bash
#
# Post-hook of the dnscrypt entry in assets.lst, run after a new binary is in place.
#
# The asset can land before main-start installs dnscrypt.service, and a restart
# under the old unit leaves out RuntimeDirectory, so /run/dnscrypt (the control
# socket's directory) is missing until the next restart. Sync the unit first.
# Then start dnscrypt only if it was running before the update.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

UNIT=dnscrypt.service

if ! cmp -s "$FIREWALLA_HOME/extension/dnscrypt/$UNIT" "/etc/systemd/system/$UNIT"; then
  sudo cp "$FIREWALLA_HOME/extension/dnscrypt/$UNIT" "/etc/systemd/system/$UNIT"
  sudo systemctl daemon-reload
fi

exec "$FIREWALLA_HOME/scripts/check_service_on_assets_update.sh" start dnscrypt
