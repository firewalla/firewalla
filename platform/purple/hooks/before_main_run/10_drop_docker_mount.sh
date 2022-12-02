#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

sudo cp ${FIREWALLA_HOME}/etc/rsyslog.d/20-drop-docker-mount.conf /etc/rsyslog.d/
sudo systemctl restart rsyslog