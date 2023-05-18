#!/bin/bash

: ${FIREWALLA_HOME:='/home/pi/firewalla'}

THRESHOLD_IN_SEC=${THRESHOLD:=3600} # 1 hour

latest=$(redis-cli zrevrange flow:conn:00:00:00:00:00:00 0 0 withscores | tail -n1)
now=$(date +%s)
idleTime=$(($now - ${latest%.*}))
echo 'Latest flow recorded '$idleTime' sec ago'
if [[ $idleTime -gt $THRESHOLD_IN_SEC ]]; then
  echo 'Threshold exceeded, restarting brofish'
  $FIREWALLA_HOME/scripts/firelog -t local -m "FLOWCHECK Latest flow recorded ${idleTime}s ago, restarting brofish"
  sudo systemctl restart brofish
fi
