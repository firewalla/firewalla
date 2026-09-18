#!/bin/bash
#
# Compatibility shim. The clock sync lives in sync_clock.sh now; this stays only so a stale
# bootstrap copy under /home/pi/scripts still reaches the current logic. Delete once no caller
# refers to it.
#
# This path used to restart the NTP daemon when it was down, so keep asking for that.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

exec env FW_CLOCK_RESTART_NTP=true "${FIREWALLA_HOME}/scripts/sync_clock.sh" "$@"
