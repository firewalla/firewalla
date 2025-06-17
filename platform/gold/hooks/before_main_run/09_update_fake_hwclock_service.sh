#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

SERVICE_FILE="/media/root-ro/usr/lib/systemd/system/fake-hwclock.service"

if [[ ! -f "$SERVICE_FILE" ]]; then
    exit 0
fi


check_dependency() {
  grep -q "^After=data.mount$" "$SERVICE_FILE" && \
  grep -q "^Requires=data.mount$" "$SERVICE_FILE"
}


add_dependency() {
  sudo sed -i '/^\[Unit\]$/a After=data.mount\nRequires=data.mount' "$SERVICE_FILE"
}


if ! check_dependency; then
  mount -t ext4 | grep "/media/root-ro" | awk '{print $6}' | grep -q -w rw
  writable=$?
  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,rw /media/root-ro
  fi
  add_dependency

  if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,ro /media/root-ro
  fi
fi

exit 0