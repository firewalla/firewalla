#!/bin/bash
#
# Compatibility shim. The clock sync lives in sync_clock.sh now; this stays only so firerouter's
# firerouter_upgrade.sh keeps working until it is pointed at sync_clock.sh directly. Delete once
# no caller refers to it.
#
# SYNC_ONCE=true meant one pass; anything else meant retry until it succeeds.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${PI_HOME:=/home/pi}

if ${SYNC_ONCE:-false}; then
  retry=1
else
  retry=0
fi

# prefer the bootstrap copy, for the same reason fire-time.sh does
SYNC_CLOCK=$PI_HOME/scripts/sync_clock.sh
[ -s "$SYNC_CLOCK" ] || SYNC_CLOCK=$FIREWALLA_HOME/scripts/sync_clock.sh

exec env FW_CLOCK_RETRY=$retry "$SYNC_CLOCK" "$@"
