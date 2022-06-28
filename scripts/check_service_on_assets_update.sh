#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

ACTION=$1
SERVICE_NAME=$2

if [ -z "$ACTION" -o -z "$SERVICE_NAME" ]; then
  exit 1
fi

SIGNAL_FILE=/home/pi/.firewalla/run/"$SERVICE_NAME".need_restart

case "$ACTION" in
  stop)
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
      touch "$SIGNAL_FILE"
      sudo systemctl stop "$SERVICE_NAME"
    else 
      rm "$SIGNAL_FILE"
    fi
  ;;
  start)
    if [ -f "$SIGNAL_FILE" ]; then
      sudo systemctl start "$SERVICE_NAME"
      rm "$SIGNAL_FILE"
    fi
  ;;
esac


