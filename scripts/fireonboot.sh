#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${LOGDIR:=/home/pi/logs}

logger Onboot start clean_log
${FIREWALLA_HOME}/scripts/clean_log.sh &> $LOGDIR/clean_log.log &

logger Onboot start sync_time
${FIREWALLA_HOME}/scripts/sync_time.sh &> $LOGDIR/sync_time.log &

wait

exit 0
