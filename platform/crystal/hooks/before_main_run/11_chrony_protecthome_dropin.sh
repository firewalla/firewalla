#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# Images built before the drop-in landed in firemaker lack it; write it into the persistent lower layer
RO_ROOT="/media/root-ro"
DROPIN_DIR="${RO_ROOT}/etc/systemd/system/chrony.service.d"
DROPIN_FILE="${DROPIN_DIR}/firewalla.conf"

if [[ ! -e "${RO_ROOT}/usr/lib/systemd/system/chrony.service" ]]; then
    exit 0
fi

# Never overwrite an existing drop-in, so later firemaker changes to it are kept
if [[ -e "$DROPIN_FILE" ]]; then
    exit 0
fi

read -r -d '' DROPIN_CONTENT <<'EOS'
# FireRouter points /etc/resolv.conf into /home/pi, which ProtectHome=yes hides from
# chronyd, leaving it unable to resolve any NTP source. chronyd only reads the file.
[Service]
ProtectHome=read-only
EOS

mount -t ext4 | grep "$RO_ROOT" | awk '{print $6}' | grep -q -w rw
writable=$?
if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,rw "$RO_ROOT" || exit 1
fi

sudo mkdir -p "$DROPIN_DIR"
echo "$DROPIN_CONTENT" | sudo tee "$DROPIN_FILE" > /dev/null

if [[ ! writable -eq 0 ]]; then
    sudo mount -o remount,ro "$RO_ROOT"
fi

sudo systemctl daemon-reload
if systemctl -q is-active chrony; then
    sudo systemctl restart chrony
fi

exit 0
