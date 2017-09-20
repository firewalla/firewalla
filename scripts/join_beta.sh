#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

cd $FIREWALLA_HOME
git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git fetch origin
# master should be changed to beta branch in the future
git checkout master
sync
logger "REBOOT: JOIN BETA"
/home/pi/firewalla/scripts/fire-reboot-normal
