#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp ${FIREWALLA_HOME}/etc/logrotate.d/dockerd.logrotate /etc/logrotate.d/dockerd
sudo chmod 644 /etc/logrotate.d/dockerd

sudo cp ${FIREWALLA_HOME}/etc/rsyslog.d/21-dockerd.conf /etc/rsyslog.d/
sudo systemctl restart rsyslog