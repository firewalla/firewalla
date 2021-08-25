#!/bin/bash

if [ $# -eq 0 ]; then
  logger "OpenConnect client: No profile ID provided, exit"
  exit 1
fi

server=$(cat /home/pi/.firewalla/run/oc_profile/$1.server)
OC_BIN_PATH=$(which openconnect)

if [[ -z $OC_BIN_PATH ]]; then
  logger "openconnect command is not found"
  exit 1
fi

cat "/home/pi/.firewalla/run/oc_profile/$1.password" | PROFILE_ID=$1 $OC_BIN_PATH --config "/home/pi/.firewalla/run/oc_profile/$1.conf" --background --passwd-on-stdin -s "/home/pi/firewalla/extension/vpnclient/oc_hook.sh" $server