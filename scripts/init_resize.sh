#!/bin/bash

DEVICE_NAME=mmcblk0
DEVICE_PATH=/dev/$DEVICE_NAME
DEVICE_SIZE=$(cat /sys/block/${DEVICE_NAME}/size)
TARGET_END=$((DEVICE_SIZE - 1))
RESIZE_MARKER=/boot/init_resize_done

expand_partition() {
    part_num=$1
    test -e $DEVICE_PATH || {
        logger "ERROR: $DEVICE_PATH NOT exist"
        return 1
    }

    part_ends=$(parted -m $DEVICE_PATH unit s print | awk -F: "/^${part_num}/ {print \$3}")
    part_end=${part_ends%s}

    if [[ "$part_end" -ge "$TARGET_END" ]]; then
        logger "INFO: Partition expansion bypassed since partition $part_num ends at ${part_end}, which is no less than device size of $TARGET_END"
        return 1
    fi

    if ! parted -m $DEVICE_PATH u s resizepart ${part_num} $TARGET_END; then
        logger "ERROR: Parition ${part_num} resize failed"
        return 1
    fi
    partprobe $DEVICE_PATH
    return 0
}

if [[ -e $RESIZE_MARKER ]]
    logger "INFO: After initial boot, NO need to resize partition any more"
else
    logger "INFO: Initial boot, resize partitions now ..."
    expand_partition 4
    expand_partition 5
    date -u > $RESIZE_MARKER
fi
