#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

ASSETSD_PATH=${FIREWALLA_HIDDEN}/config/assets.d/

mkdir -p $ASSETSD_PATH
sudo chown pi:pi $ASSETSD_PATH -R

RELEASE_HASH=$(cat /etc/firewalla_release | grep HASH | cut -d: -f2 | xargs echo -n)

if [ -f "${FW_PLATFORM_CUR_DIR}/files/assets.lst" ]; then
  cp "${FW_PLATFORM_CUR_DIR}/files/assets.lst" "${ASSETSD_PATH}/00_assets.lst"
fi

if [ -f "${FW_PLATFORM_CUR_DIR}/files/${RELEASE_HASH}/patch.lst" ]; then
  cp "${FW_PLATFORM_CUR_DIR}/files/${RELEASE_HASH}/patch.lst" "${ASSETSD_PATH}/05_patch.lst"
fi
