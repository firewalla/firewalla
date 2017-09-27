#!/bin/bash

ROOT_PART=$(findmnt / | awk '/^\// {print $2}')
[[ $ROOT_PART == 'overlayroot' ]] && \
    ROOT_PART=$(findmnt /media/root-ro | awk '/^\// {print $2}')
DEVICE_NAME=$(echo /sys/block/*/${ROOT_PART#/dev/} | awk -F/ '{print $4}')
DEVICE_PATH=/dev/$DEVICE_NAME
DEVICE_SIZE=$(cat /sys/block/${DEVICE_NAME}/size)
TARGET_END=$((DEVICE_SIZE - 1))
RESIZE_MARKER=/media/root-rw/init_resize_done

expand_partition() {
    part_num=$1
    part_ends=$(parted -m $DEVICE_PATH unit s print | awk -F: "/^${part_num}/ {print \$3}")
    part_end=${part_ends%s}

    if [[ -z "$part_end" ]]; then
        logger "WARN: Partition $part_num not exists on device $DEVICE_PATH"
        return 0
    fi

    if [[ "$part_end" -ge "$TARGET_END" ]]; then
        logger "INFO: Partition $part_num ends at ${part_end}, no less than device size of $TARGET_END, bypassed"
        return 1
    fi

    if ! parted -m $DEVICE_PATH u s resizepart ${part_num} yes $TARGET_END; then
        logger "ERROR: Parition ${part_num} resize failed"
        return 1
    fi
    partprobe $DEVICE_PATH
    return 0
}

# ------------------
# main goes here
# ------------------

test -e $DEVICE_PATH || {
    logger "ERROR: $DEVICE_PATH NOT exist"
    exit 1
}

rc=0
if [[ -e $RESIZE_MARKER ]]
then
    logger "INFO: Resize done before, bypass"
else
    logger "INFO: Initial boot, resize partitions now ..."
    expand_partition 4 || rc=1
    expand_partition 5 || rc=1
    date -u > $RESIZE_MARKER || rc=1
fi

exit $rc
