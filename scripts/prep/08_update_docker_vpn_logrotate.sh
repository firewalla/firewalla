#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp $FIREWALLA_HOME/etc/logrotate.d/docker_vpn.logrotate /etc/logrotate.d/docker_vpn
sudo chmod 644 /etc/logrotate.d/docker_vpn