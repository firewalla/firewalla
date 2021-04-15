#!/bin/bash

# kill background process
/home/pi/firewalla/scripts/fire-stop

# clean database
/usr/bin/redis-cli flushall

# remove rdb file in case of corrupted rdb files
sudo systemctl stop redis-server
sudo rm /data/redis/*

# clean up logs
: ${FIREWALLA_LOG_DIR:=/log}

sudo rm -fr ${FIREWALLA_LOG_DIR}/*/*

# clean up upper directory
: ${FIREWALLA_UPPER_MP:=/media/root-rw}
: ${FIREWALLA_LOWER_MP:=/media/root-ro}
: ${FIREWALLA_UPPER_DEV:=/dev/mmcblk0p2}
: ${FIREWALLA_LOWER_DEV:=/dev/mmcblk0p1}

FIREWALLA_UPPER_SUBDIR=root
FIREWALLA_WORK_SUBDIR=work
sudo mkdir -p $FIREWALLA_LOWER_MP $FIREWALLA_UPPER_MP
sudo mount -o ro $FIREWALLA_LOWER_DEV $FIREWALLA_LOWER_MP
sudo mount $FIREWALLA_UPPER_DEV $FIREWALLA_UPPER_MP

FIREWALLA_UPPER_DIR=${FIREWALLA_UPPER_MP}/${FIREWALLA_UPPER_SUBDIR}
FIREWALLA_UPPER_WORK_DIR=${FIREWALLA_UPPER_MP}/${FIREWALLA_WORK_SUBDIR}


sudo rm -rf ${FIREWALLA_UPPER_DIR}.bak ${FIREWALLA_UPPER_WORK_DIR}.bak
sudo mv ${FIREWALLA_UPPER_DIR}{,.bak}
sudo mv ${FIREWALLA_UPPER_WORK_DIR}{,.bak}

# store tech support file
/home/pi/firewalla/scripts/store_support.sh

# touch a fw reset file to support new image
if [[ -f /support_fw_reset || -f /etc/support_fw_reset ]]; then
    sudo mount -o remount,rw ${FIREWALLA_LOWER_MP}
    sudo touch ${FIREWALLA_LOWER_MP}/fw_reset
    sudo mount -o remount,ro ${FIREWALLA_LOWER_MP}
fi
sync
sync
: ${FIREWALLA_POST_RESET_OP:='reboot'}

if [[ $FIREWALLA_POST_RESET_OP == 'shutdown' ]]; then
    logger "SHUTDOWN: User SHUTDOWN"
    : ${FIREWALLA_SHUTDOWN_NORMAL_SCRIPT:=/home/pi/firewalla/scripts/fire-shutdown-normal}

    $FIREWALLA_SHUTDOWN_NORMAL_SCRIPT
else
    logger "REBOOT: User REBOOT"
    : ${FIREWALLA_REBOOT_NORMAL_SCRIPT:=/home/pi/firewalla/scripts/fire-reboot-normal}

    $FIREWALLA_REBOOT_NORMAL_SCRIPT
fi
