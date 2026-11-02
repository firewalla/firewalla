#!/bin/bash
#
# Compatibility shim. The clock sync lives in sync_clock.sh now; this stays only so a stale
# bootstrap copy under /home/pi/scripts still reaches the current logic. Delete once no caller
# refers to it.
#
# This path used to restart the NTP daemon when it was down, so keep asking for that.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${PI_HOME:=/home/pi}

# prefer the bootstrap copy. this shim is itself copied to $PI_HOME/scripts, and that folder exists
# to keep working when the repo tree is broken - reaching back into it here would defeat the point
SYNC_CLOCK=$PI_HOME/scripts/sync_clock.sh
[ -s "$SYNC_CLOCK" ] || SYNC_CLOCK=$FIREWALLA_HOME/scripts/sync_clock.sh

exec env FW_CLOCK_RESTART_NTP=true "$SYNC_CLOCK" "$@"
