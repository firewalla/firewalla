#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
TAG="FIREWALLA:PATCH_TZDATA"
source $FIREWALLA_HOME/scripts/apt_utils.sh

apt_lock || { logger "$TAG:SKIP:ALREADY_RUNNING"; exit 0; }
apt_due tzdata $(( 86400 * 30 )) || { logger "$TAG:SKIP:WITHIN_30_DAYS"; exit 0; }
apt_defer tzdata $(( 86400 * 30 ))
trap 'exit 143' TERM INT
# a failed or killed run is retried after a day, not after 30
trap 'rc=$?; (( rc )) && apt_defer tzdata 86400; apt_cleanup' EXIT

$FIREWALLA_HOME/scripts/apt-get.sh --no-reboot install tzdata \
  || { logger "$TAG:ERROR:APT_GET_FAILED code $?"; exit 1; }
logger "$TAG:DONE"
