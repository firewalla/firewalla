#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

${FIREWALLA_HOME}/scripts/clean_log.sh &> /dev/null