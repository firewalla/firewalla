#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# hide script normal output to log, only show error
exec > /tmp/13_redis_config_maxmemory.log

redis_run() {
    su - redis -s /bin/bash -c "$@"
}

CUR_VALUE=$(redis-cli config get maxmemory | tail -n 1)

# reset to 0 if already set to none-zero by previous legacy code
if [[ "$CUR_VALUE" -ne 0 ]]; then
  redis_run "redis-cli config set maxmemory 0"
fi

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

exit 0

redis_run "redis-cli config set maxmemory ${REDIS_MAXMEMORY:-0}"
redis_run "redis-cli config rewrite"
redis_run "redis-cli config get maxmemory"
