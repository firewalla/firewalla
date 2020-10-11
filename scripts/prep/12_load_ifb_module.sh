#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $IFB_SUPPORTED == "yes" ]]; then
  sudo modprobe ifb &> /dev/null || true
else
  sudo rmmod ifb &> /dev/null || true
fi