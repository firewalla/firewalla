#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp $FIREWALLA_HOME/etc/logrotate.d/openvpn.logrotate /etc/logrotate.d/openvpn
sudo chmod 644 /etc/logrotate.d/openvpn