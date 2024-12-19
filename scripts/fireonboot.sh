#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${LOGDIR:=/home/pi/logs}

source $FIREWALLA_HOME/scripts/utils.sh
setup_folders

logger Onboot start clean_log
${FIREWALLA_HOME}/scripts/clean_log.sh &> $LOGDIR/clean_log.log &

logger Onboot start sync_time
${FIREWALLA_HOME}/scripts/sync_time.sh &> $LOGDIR/sync_time.log &

# check redis.conf in root-ro partition and remove defualt maxmemory config
if sudo grep -q "^maxmemory " /media/root-ro/etc/redis/redis.conf; then
  mount -t ext4 | grep "/media/root-ro" | awk '{print $6}' | grep -q -w rw
  writable=$?
  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,rw /media/root-ro
  fi
  sudo sed -i '/^maxmemory /d' /media/root-ro/etc/redis/redis.conf
  redis-cli config set maxmemory 0
  # overwrite redis.conf in root-rw
  sudo sed -i '/^maxmemory /d' /etc/redis/redis.conf
  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,ro /media/root-ro
  fi
fi

DIR_D="/home/pi/.firewalla/config/fireonboot.d"

if [[ -d $DIR_D ]]; then
  for script in $(ls $DIR_D/*.sh)
  do
      bash $script
  done
fi

wait

exit 0
