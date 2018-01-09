#!/bin/bash

# flag to run this script
FLAG_FILE=/tmp/RESET_OVERLAYFS_BEFORE_SHUTDOWN

if [[ -e "$FLAG_FILE" ]]
then
    echo "INFO: File $FLAG_FILE detected. Reset overlayfs before shutdown."
    rm -f $FLAG_FILE
else
    echo "INFO: File $FLAG_FILE NOT exist. Bypass overlayfs reset."
    exit 0
fi

# kill background process
/home/pi/firewalla/scripts/fire-stop

# clean database
/usr/bin/redis-cli flushall

# clean up logs
: ${FIREWALLA_LOG_DIR:=/log}

sudo rm -fr ${FIREWALLA_LOG_DIR}/*/*

# clean up upper directory
: ${FIREWALLA_UPPER_DIR:=/media/root-rw/overlay}
: ${FIREWALLA_UPPER_WORK_DIR:=/media/root-rw/overlay-workdir}

sudo rm -rf ${FIREWALLA_UPPER_DIR}.bak ${FIREWALLA_UPPER_WORK_DIR}.bak
sudo mv ${FIREWALLA_UPPER_DIR}{,.bak}
sudo mv ${FIREWALLA_UPPER_WORK_DIR}{,.bak}

sync
