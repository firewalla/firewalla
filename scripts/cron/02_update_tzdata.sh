#!/bin/bash

TAG="FIREWALLA:PATCH_TZDATA"

tzdata_ts_file=/dev/shm/tzdata_apt_update_ts
now=$(date +%s)
if [[ ! -e $tzdata_ts_file ]] || (( $(cat $tzdata_ts_file) < $now - 86400 * 30 )); then
  sudo timeout 10 dpkg --configure -a --force-confold
  sudo timeout 90 apt update \
    || { logger "$TAG:ERROR:APT_UPDATE_FAILED code $?"; exit 1; }
  sudo timeout 60 apt install -o Dpkg::Options::="--force-confold" -y tzdata \
    || { logger "$TAG:ERROR:APT_INSTALL_FAILED code $?"; exit 1; }
  echo $now > $tzdata_ts_file
  logger "$TAG:DONE"

  sudo apt clean
  sudo rm -rf /log/apt/lib/lists/*
else
  logger "$TAG:SKIP:WITHIN_30_DAYS"
fi
