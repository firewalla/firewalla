#!/bin/bash

NO_REBOOT=0
FORCE_REBOOT=1
NORMAL_REBOOT=2
REBOOT_TYPE=$NO_REBOOT
: ${FIREWALLA_HOME:=/home/pi/firewalla}

check_kernel_fatal_err_update_clk_timeout() {
    if sudo dmesg | fgrep 'sunxi-mmc 1c0f000.mmc: fatal err update clk timeout'
    then
        logger "FATAL: sunxi-mmc 1c0f000.mmc: fatal err update clk timeout"
        REBOOT_TYPE=$FORCE_REBOOT
        return 0
    else
        return 1
    fi
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

check_kernel_fatal_err_update_clk_timeout

case $REBOOT_TYPE in
    $NO_REBOOT)
        logger No reboot needed
        ;;
    $FORCE_REBOOT)
        logger Force reboot
        $FIREWALLA_HOME/scripts/fire-rebootf
        ;;
    $NORMAL_REBOOT)
        logger Normal reboot
        sync && /home/pi/firewalla/scripts/fire-reboot-normal
        ;;
esac

exit 0
