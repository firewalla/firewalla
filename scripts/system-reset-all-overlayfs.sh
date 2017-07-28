#!/bin/bash

sudo service firemain stop
sudo service firemon stop

# clean database
/usr/bin/redis-cli flushall

# clean up logs
: ${FIREWALLA_LOG_DIR:=/log}

sudo rm -fr ${FIREWALLA_LOG_DIR}/*/*

# clean up upper directory
: ${FIREWALLA_UPPER_DIR:=/media/root-rw/overlay}
: ${FIREWALLA_UPPER_WORK_DIR:=/media/root-rw/overlay-workdir}

sudo mv ${FIREWALLA_UPPER_DIR}{,.bak}
sudo mv ${FIREWALLA_UPPER_WORK_DIR}{,.bak}

sync
sync
logger "REBOOT: User REBOOT"
: ${FIREWALLA_REBOOT_NORMAL_SCRIPT:=/home/pi/firewalla/scripts/fire-reboot-normal}

$FIREWALLA_REBOOT_NORMAL_SCRIPT
