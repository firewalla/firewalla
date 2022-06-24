#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp $FIREWALLA_HOME/etc/logrotate.d/openconnect.logrotate /etc/logrotate.d/openconnect
sudo chmod 644 /etc/logrotate.d/openconnect