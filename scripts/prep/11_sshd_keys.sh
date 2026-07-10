#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  exit 0
fi

ls /etc/ssh/ssh_host_* &>/dev/null || sudo dpkg-reconfigure openssh-server &> /dev/null
