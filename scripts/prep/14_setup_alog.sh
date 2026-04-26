#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# Setup ALOG (Audit Log) filesystem if supported
if [[ $ALOG_SUPPORTED == "yes" ]]; then
  sudo mkdir -p /alog/
  sudo rm -r -f /alog/*
  sudo umount -l /alog
  sudo mount -t tmpfs -o size=20m tmpfs /alog
fi
