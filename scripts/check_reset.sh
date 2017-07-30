#!/bin/bash

# 1. check if there is usb drive attached. (just do a mount is enough)
# 2. if there is USB drive mounted, check if there is file name "firewalla_reset" file in / of USB
# 3. if yes, then call the overlayfs reset function, then delete the file if you can. (prevent next reboot, also go to infiitnte reset)
# 4. if no, proceed.

USB_MOUNT=/media/usb
USB_DEV=/dev/sda1
RESET_FILE='firewalla_reset'
USB_RESET_FILE="${USB_MOUNT}/${RESET_FILE}"
RESET_SCRIPT='/media/root-ro/home/pi/firewalla/scripts/system-reset-all-overlayfs.sh'

mkdir -p ${USB_MOUNT}
test -e ${USB_DEV} || exit 1
/bin/mount ${USB_DEV} ${USB_MOUNT}
test -e ${USB_RESET_FILE}; need_reset=$?
rm -f ${USB_RESET_FILE}; delete_ok=$?
/bin/umount ${USB_MOUNT}
if [[ ${need_reset} -eq 0 && ${delete_ok} -eq 0 ]]
then
    logger "${USB_RESET_FILE} detected, reset overlayfs"
    echo exec $RESET_SCRIPT
else
    logger "${USB_RESET_FILE} NOT found"
fi

exit 0
