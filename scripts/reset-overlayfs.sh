#!/bin/bash

set -x

FLAG_FILE=/var/run/RESET_OVERLAYFS_BEFORE_SHUTDOWN
MOUNT_DEV=/dev/mmcblk0p4
MOUNT_DIR=/media/root-reset
LOG_FILE=$MOUNT_DIR/reset-overlayfs.log

mkdir -p $MOUNT_DIR
mount $MOUNT_DEV $MOUNT_DIR

rm -f $LOG_FILE
exec &> $LOG_FILE

if [[ -e "$FLAG_FILE" ]]
then
    echo "INFO: File $FLAG_FILE detected. Reset overlayfs before shutdown."
    rm -f $FLAG_FILE
else
    echo "INFO: File $FLAG_FILE NOT exist. Bypass overlayfs reset."
    umount $MOUNT_DIR
    exit 0
fi

# clean up upper directory
FIREWALLA_UPPER_DIR=$MOUNT_DIR/overlay
FIREWALLA_UPPER_WORK_DIR=$MOUNT_DIR/overlay-workdir

sudo rm -rf ${FIREWALLA_UPPER_DIR}.bak ${FIREWALLA_UPPER_WORK_DIR}.bak
sudo mv ${FIREWALLA_UPPER_DIR}{,.bak}
sudo mv ${FIREWALLA_UPPER_WORK_DIR}{,.bak}

sync

umount $MOUNT_DIR
