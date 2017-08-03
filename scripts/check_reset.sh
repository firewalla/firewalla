#!/bin/bash

#
#    Copyright 2017 Firewalla LLC 
# 
#    This program is free software: you can redistribute it and/or  modify
#    it under the terms of the GNU Affero General Public License, version 3,
#    as published by the Free Software Foundation.
# 
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <http://www.gnu.org/licenses/>.
#


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
    exec $RESET_SCRIPT
else
    logger "${USB_RESET_FILE} NOT found"
fi

exit 0
