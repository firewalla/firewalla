#!/bin/bash

tzdata_ts_file=/dev/shm/tzdata_apt_update_ts
now=$(date +%s)
if [[ ! -e $tzdata_ts_file ]] || (( $(cat $tzdata_ts_file) < $now - 86400 * 30 )); then
  sudo timeout 10 dpkg --configure -a --force-confold
  sudo timeout 60 apt update
  sudo timeout 60 apt install -o Dpkg::Options::="--force-confold" -y tzdata
  echo $now > $tzdata_ts_file
  sudo apt clean
  sudo rm -rf /log/apt/lib/lists/*
fi
