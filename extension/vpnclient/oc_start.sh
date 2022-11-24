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

SEED_FILE="/home/pi/.firewalla/run/oc_profile/$1.seed"
PASSWD_FILE="/home/pi/.firewalla/run/oc_profile/$1.password"
CONF_FILE="/home/pi/.firewalla/run/oc_profile/$1.conf"
VPNC_SCRIPT="/home/pi/firewalla/extension/vpnclient/oc_hook.sh"

if test -s $SEED_FILE; then
  TOTP_BIN="/home/pi/.firewalla/run/assets/totp"
  $TOTP_BIN config update vpn_client_$1 $(cat $SEED_FILE)
  echo -e "$(cat $PASSWD_FILE)\n$($TOTP_BIN vpn_client_$1)" | PROFILE_ID=$1 $OC_BIN_PATH --config "$CONF_FILE" --background --passwd-on-stdin -s "$VPNC_SCRIPT" $server
else
  cat "$PASSWD_FILE" | PROFILE_ID=$1 $OC_BIN_PATH --config "$CONF_FILE" --background --passwd-on-stdin -s "$VPNC_SCRIPT" $server
fi