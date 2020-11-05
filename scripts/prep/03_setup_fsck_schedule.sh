#!/bin/bash

MOUNT_COUNT=1
INTERVAL=4w

if ls -1 /dev/mmcblk0p* &> /dev/null; then
    for device in `ls -1 /dev/mmcblk0p*`; do
        (sudo file -sL $device | grep "Linux rev 1.0 ext4" &> /dev/null) && sudo tune2fs -c $MOUNT_COUNT -i $INTERVAL $device > /dev/null
    done
fi
