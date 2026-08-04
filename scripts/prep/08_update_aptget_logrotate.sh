#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp $FIREWALLA_HOME/etc/logrotate.d/apt-get.logrotate /etc/logrotate.d/apt-get
sudo chmod 644 /etc/logrotate.d/apt-get