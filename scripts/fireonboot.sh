#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${LOGDIR:=/home/pi/logs}

source $FIREWALLA_HOME/scripts/utils.sh
setup_folders

logger Onboot start clean_log
${FIREWALLA_HOME}/scripts/clean_log.sh &> $LOGDIR/clean_log.log &

logger Onboot start sync_time
${FIREWALLA_HOME}/scripts/sync_time.sh &> $LOGDIR/sync_time.log &


DIR_D="/home/pi/.firewalla/config/fireonboot.d"

if [[ -d $DIR_D ]]; then
  for script in $(ls $DIR_D/*.sh)
  do
      bash $script
  done
fi

wait

exit 0
