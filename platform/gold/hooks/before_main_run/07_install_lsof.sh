#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $(lsb_release -cs) == "focal" ]]; then
  /usr/bin/which lsof || ( sudo cp ${FW_PLATFORM_CUR_DIR}/files/u20/lsof /usr/bin/lsof; sudo chmod +x /usr/bin/lsof )
fi

exit 0