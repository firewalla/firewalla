#!/bin/bash

# ignore zram in dockerenv
if [[ -f /.dockerenv ]]; then
  exit 0
fi

modprobe zram num_devices=4

totalmem=$(free -m | awk '/Mem:/{print $2}')
mem=$(( ($totalmem / 4 / 2 )* 1024 * 1024 ))

for i in `seq 0 3`; do
  echo $mem > /sys/block/zram${i}/disksize 2>/dev/null
  mkswap /dev/zram${i} &>/dev/null
  swapon -p 5 /dev/zram${i} &>/dev/null
done
