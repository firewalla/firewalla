#!/bin/bash

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

# touch a fw reset file to support new image
if [[ -f /support_fw_reset || -f /etc/support_fw_reset ]]; then
    sudo mount -o remount,rw /media/root-ro
    sudo touch /media/root-ro/fw_reset
    sudo mount -o remount,ro /media/root-ro
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
