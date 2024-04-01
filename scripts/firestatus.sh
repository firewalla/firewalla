#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

: ${FIRESTATUS_DIR:=$HOME/.firewalla/run/firestatus}

mkdir -p ${FIRESTATUS_DIR}

: ${FIRESTATUS_BIN:=${FIRESTATUS_DIR}/firestatus}
: ${FIRESTATUS_CONFIG:=${FIRESTATUS_DIR}/config.yml}

USE_SUDO=""
if [[ $RUN_FIRESTATUS_AS_ROOT == "yes" ]]; then
  USE_SUDO="sudo"
fi

if [[ -e $FIRESTATUS_BIN ]]; then
  ${USE_SUDO} ${FIRESTATUS_BIN} -config ${FIRESTATUS_CONFIG} -platform ${FIREWALLA_PLATFORM}
else
  logger "firestatus binary not exist, skipping"
  sleep infinity
fi
