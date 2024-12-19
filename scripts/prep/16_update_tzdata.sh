#!/bin/bash

tzdata_ts_file=/dev/shm/tzdata_update_ts
now=$(date +%s)
if [[ ! -e $tzdata_ts_file ]] || (( $(cat $tzdata_ts_file) < $now - 86400 * 30 )); then
  sudo dpkg --configure -a
  sudo timeout 60 \apt update
  sudo timeout 60 \apt install -y tzdata
  echo $now > $tzdata_ts_file
fi
