#!/bin/bash

: ${FIREWALLA_HOME:='/home/pi/firewalla'}

THRESHOLD_IN_SEC=${THRESHOLD:=900} # 15 mins

latest=$(redis-cli --scan --pattern flow:conn:* | xargs -i redis-cli zrevrange {} 0 0 withscores | sed -n 'n;p' | sort -r | head -n1)
now=$(date +%s)
idleTime=$(($now - ${latest%.*}))
echo 'Latest flow recorded '$idleTime' sec ago'
if [[ $idleTime -gt $THRESHOLD_IN_SEC ]]; then
  echo 'Threshold exceeded, restarting firemain'
  $FIREWALLA_HOME/scripts/firelog -t local -m "FLOWCHECK Latest flow recorded ${idleTime}s ago, restarting firemain"
  sudo systemctl restart firemain
fi
