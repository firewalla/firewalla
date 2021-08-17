#!/bin/bash


: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

${NEED_FIRESTATUS:=false} && curl 'http://127.0.0.1:9966/resolve?name=firekick&type=ready_for_pairing'