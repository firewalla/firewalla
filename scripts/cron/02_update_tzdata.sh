#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
TAG="FIREWALLA:PATCH_TZDATA"
source $FIREWALLA_HOME/scripts/apt_utils.sh

apt_lock || { logger "$TAG:SKIP:ALREADY_RUNNING"; exit 0; }
apt_due tzdata $(( 86400 * 30 )) || { logger "$TAG:SKIP:WITHIN_30_DAYS"; exit 0; }
# retried after a day unless it completes, also when the run is cut by a power loss or a kill
apt_defer tzdata 86400
trap 'exit 143' TERM INT
trap apt_cleanup EXIT

$FIREWALLA_HOME/scripts/apt-get.sh --no-reboot install tzdata \
  || { logger "$TAG:ERROR:APT_GET_FAILED code $?"; exit 1; }
apt_defer tzdata $(( 86400 * 30 ))
logger "$TAG:DONE"
