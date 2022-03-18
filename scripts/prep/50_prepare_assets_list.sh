#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

ASSETSD_PATH=${FIREWALLA_HIDDEN}/run/assets.d/

rm -rf $ASSETSD_PATH
mkdir -p $ASSETSD_PATH

CODE_NAME=$(lsb_release -cs)

if [ -f "${FW_PLATFORM_CUR_DIR}/files/assets.lst" ]; then
  cp "${FW_PLATFORM_CUR_DIR}/files/assets.lst" "${ASSETSD_PATH}/00_assets.lst"
fi

if [ -f "${FW_PLATFORM_CUR_DIR}/files/${CODE_NAME}/patch.lst" ]; then
  cp "${FW_PLATFORM_CUR_DIR}/files/${CODE_NAME}/patch.lst" "${ASSETSD_PATH}/05_patch.lst"
fi
