#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
TAG="FIREWALLA:PATCH_TZDATA"

tzdata_ts_file=/dev/shm/tzdata_apt_update_ts
now=$(date +%s)
if [[ ! -e $tzdata_ts_file ]] || (( $(cat $tzdata_ts_file) < $now - 86400 * 30 )); then
  $FIREWALLA_HOME/scripts/apt-get.sh --no-reboot install tzdata \
    || { logger "$TAG:ERROR:APT_GET_FAILED code $?"; exit 1; }
  echo $now > $tzdata_ts_file
  logger "$TAG:DONE"

  sudo apt clean
  sudo rm -rf /log/apt/lib/lists/*
else
  logger "$TAG:SKIP:WITHIN_30_DAYS"
fi
