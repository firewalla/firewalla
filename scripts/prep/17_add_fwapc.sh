#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ ${HAVE_FWAPC} == "yes" ]]; then
  if ! cmp -s ${FIREWALLA_HOME}/etc/fwapc.service /etc/systemd/system/fwapc.service; then
    sudo cp ${FIREWALLA_HOME}/etc/fwapc.service /etc/systemd/system/.
    sudo systemctl daemon-reload
    if systemctl -q is-active fwapc; then
      sudo systemctl restart fwapc
    fi
  fi
fi

exit 0