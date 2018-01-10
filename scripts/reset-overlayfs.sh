#!/bin/bash

if [[ $(id -u) != $(id -u root) ]]
then
    echo "ERROR: only ROOT can run this script" >&2
    exit 1
fi

LOG_DEV=/dev/mmcblk0p3
LOG_DIR=/log
RESET_DEV=/dev/mmcblk0p4
RESET_DIR=/media/root-reset
FLAG_FILE=$LOG_DIR/RESET_OVERLAYFS_BEFORE_SHUTDOWN
LOG_FILE=$LOG_DIR/reset-overlayfs.log

mount $LOG_DEV $LOG_DIR
mount -oremount,rw $LOG_DIR

rm -f $LOG_FILE
exec &> $LOG_FILE

if [[ -e "$FLAG_FILE" ]]
then
    echo "INFO: File $FLAG_FILE detected. Reset overlayfs before shutdown."
    rm -f $FLAG_FILE

    # remount / so that /media is writable
    mount -oremount,rw /
    mkdir -p $RESET_DIR
    mount $RESET_DEV $RESET_DIR

    # clean up upper directory
    FIREWALLA_UPPER_DIR=$RESET_DIR/overlay
    FIREWALLA_UPPER_WORK_DIR=$RESET_DIR/overlay-workdir

    rm -rf ${FIREWALLA_UPPER_DIR}.bak ${FIREWALLA_UPPER_WORK_DIR}.bak
    mv ${FIREWALLA_UPPER_DIR}{,.bak}
    mv ${FIREWALLA_UPPER_WORK_DIR}{,.bak}

    sync
else
    echo "INFO: File $FLAG_FILE NOT exist. Bypass overlayfs reset."
fi


umount $LOG_DIR
umount $RESET_DIR
mount -oremount,ro /
