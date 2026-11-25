#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

RO_ROOT="/media/root-ro"
SERVICE_FILE="${RO_ROOT}/etc/systemd/system/fake-hwclock-load.service"

if [[ ! -e "${RO_ROOT}/usr/lib/systemd/system/fake-hwclock-load.service" ]]; then
    exit 0
fi

read -r -d '' SERVICE_CONTENT <<'EOS'
[Unit]
Description=Restore the current clock
Documentation=man:fake-hwclock(8)
DefaultDependencies=no
Requires=data.mount
After=data.mount
Before=sysinit.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/fake-hwclock load

[Install]
WantedBy=sysinit.target
EOS

if [[ "$(cat "$SERVICE_FILE" 2>/dev/null)" == "$SERVICE_CONTENT" ]]; then
    exit 0
fi

mount -t ext4 | grep "$RO_ROOT" | awk '{print $6}' | grep -q -w rw
writable=$?
if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,rw "$RO_ROOT"
fi

echo "$SERVICE_CONTENT" | sudo tee "$SERVICE_FILE" > /dev/null

if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,ro "$RO_ROOT"
fi

exit 0
