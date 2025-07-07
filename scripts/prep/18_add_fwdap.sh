#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ ${HAVE_FWDAP} == "yes" ]]; then
  if ! cmp -s ${FIREWALLA_HOME}/etc/fwdap.service /etc/systemd/system/fwdap.service; then
    sudo cp ${FIREWALLA_HOME}/etc/fwdap.service /etc/systemd/system/.
    sudo systemctl daemon-reload
    if systemctl -q is-active fwdap; then
      sudo systemctl restart fwdap
    fi
  fi
fi

exit 0 