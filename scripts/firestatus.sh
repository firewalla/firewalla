#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

: ${FIRESTATUS_DIR:=$HOME/.firewalla/run/firestatus}

mkdir -p ${FIRESTATUS_DIR}

: ${FIRESTATUS_BIN:=${FIRESTATUS_DIR}/firestatus}
: ${FIRESTATUS_CONFIG:=${FIRESTATUS_DIR}/config.yml}

if [[ -e $FIRESTATUS_BIN ]]; then
  ${FIRESTATUS_BIN} -config ${FIRESTATUS_CONFIG}
else
  logger "firestatus binary not exist, skipping"
  sleep infinity
fi
