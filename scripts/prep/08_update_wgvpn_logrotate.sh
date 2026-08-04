#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp $FIREWALLA_HOME/etc/logrotate.d/wgvpn.logrotate /etc/logrotate.d/wireguard
sudo chmod 644 /etc/logrotate.d/wireguard