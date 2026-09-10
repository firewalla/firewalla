#!/bin/bash
#
# Post-install hook for the fleet asset (see platform/*/files/assets.lst):
# a new binary was downloaded to ~/.firewalla/run/assets/fleet. Re-apply the
# flow-engine knobs (the drop-ins may have been held back while the binary
# was missing) and restart whichever services run fleet. With both knobs at
# their stock values this does nothing.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
exec ${FIREWALLA_HOME}/scripts/fleet-engine.sh restart
