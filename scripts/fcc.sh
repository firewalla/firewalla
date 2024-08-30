#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $FIREWALLA_PLATFORM == "purple" ]]; then
  PIDS_LIMIT=300
  PIDS_CURRENT=$(cat /sys/fs/cgroup/pids/system.slice/cron.service/pids.current)
  if [[ $PIDS_CURRENT -ge $PIDS_LIMIT ]]; then
    sudo systemctl stop cron
    cat /sys/fs/cgroup/pids/system.slice/cron.service/tasks | sudo xargs kill -9
    sudo rmdir /sys/fs/cgroup/*/system.slice/cron.service
    sudo systemctl start cron
  fi
fi

exit 0