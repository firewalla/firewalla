#!/bin/bash

MOUNT_COUNT=20
INTERVAL=4w

for device in `ls -1 /dev/mmcblk0p*`; do
    sudo tune2fs -c $MOUNT_COUNT -i $INTERVAL $device > /dev/null
done