#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ ${HAVE_FWAPC} == "yes" ]]; then
  sudo cp ${FIREWALLA_HOME}/etc/fwapc.service /etc/systemd/system/.
  sudo systemctl daemon-reload
  test -f /home/pi/.firewalla/run/assets/fwapc && sudo systemctl start fwapc &>/dev/null # fwapc will be downloaded and updated via assets framework
fi

exit 0