#!/bin/bash

MOUNT_COUNT=1
INTERVAL=4w

if ls -1 /dev/mmcblk0p* &> /dev/null; then
    for device in `ls -1 /dev/mmcblk0p*`; do
        sudo tune2fs -c $MOUNT_COUNT -i $INTERVAL $device > /dev/null
    done
fi
