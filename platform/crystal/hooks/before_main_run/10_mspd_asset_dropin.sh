#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

DROPIN_DIR="/etc/systemd/system/mspd.service.d"
DROPIN_FILE="${DROPIN_DIR}/asset.conf"

if [[ ! -e /etc/systemd/system/mspd.service ]]; then
    exit 0
fi

read -r -d '' DROPIN_CONTENT <<'EOS'
[Service]
ExecStart=
ExecStart=/bin/bash -c 'MSPD=/home/pi/.firewalla/run/assets/mspd; [[ -x $$MSPD ]] || MSPD=/usr/bin/mspd; exec $$MSPD daemon --interval 4h --log /home/pi/logs/mspd.log'
EOS

if [[ "$(cat "$DROPIN_FILE" 2>/dev/null)" == "$DROPIN_CONTENT" ]]; then
    exit 0
fi

sudo mkdir -p "$DROPIN_DIR"
echo "$DROPIN_CONTENT" | sudo tee "$DROPIN_FILE" > /dev/null
sudo systemctl daemon-reload
if systemctl -q is-active mspd; then
    sudo systemctl restart mspd
fi

exit 0
