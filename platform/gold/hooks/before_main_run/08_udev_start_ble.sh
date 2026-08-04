#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source "${FIREWALLA_HOME}/platform/platform.sh"

sudo cp "${FW_PLATFORM_CUR_DIR}/files/udev/55-start_ble.rules" /etc/udev/rules.d/

# allow udev access to 127.0.0.1
# grep -v "IPAddressAllow" /lib/systemd/system/systemd-udevd.service | sudo tee /etc/systemd/system/systemd-udevd.service 1> /dev/null
sudo cp /lib/systemd/system/systemd-udevd.service /etc/systemd/system/systemd-udevd.service
sudo tee -a /etc/systemd/system/systemd-udevd.service 1> /dev/null <<< 'IPAddressAllow=127.0.0.1'
sudo systemctl daemon-reload
sudo systemctl restart udev
