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

: ${USB_MOUNT:=/media/usb}

# FIXME: /dev/sda1 is not USB in Gold
: ${USB_DEV:=/dev/sda1}
CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

[ -s $CUR_DIR/network_settings.sh ] && source $CUR_DIR/network_settings.sh ||
    source $FIREWALLA_HOME/scripts/network_settings.sh

if [[ $FIREWALLA_PLATFORM == "gold" ]] || [[ $FIREWALLA_PLATFORM == "purple" ]]; then
    exit 0
fi

RESET_FILE='firewalla_reset'
RESET_SPOOF_FILE='firewalla_no_spoof'
USB_RESET_FILE="${USB_MOUNT}/${RESET_FILE}"
USB_RESET_SPOOF_FILE="${USB_MOUNT}/${RESET_SPOOF_FILE}"
RESET_SCRIPT='/media/root-ro/home/pi/firewalla/scripts/system-reset-all-overlayfs.sh'

mkdir -p ${USB_MOUNT}
test -e ${USB_DEV} || exit 1
/bin/mount ${USB_DEV} ${USB_MOUNT}
test -e ${USB_RESET_FILE}; need_reset=$?
test -e ${USB_RESET_SPOOF_FILE}; need_reset_spoof=$?
rm -f ${USB_RESET_FILE}; delete_ok=$?
rm -f ${USB_RESET_SPOOF_FILE}; delete_spoof_ok=$?
/bin/umount ${USB_MOUNT}
if [[ ${need_reset} -eq 0 && ${delete_ok} -eq 0 ]]
then
    logger "${USB_RESET_FILE} detected, reset overlayfs"
    exec $RESET_SCRIPT
else
    logger "${USB_RESET_FILE} NOT found"
fi
if [[ ${need_reset_spoof} -eq 0 && ${delete_spoof_ok} -eq 0 ]]
then
    logger "${USB_RESET_SPOOF_FILE} detected, reset spoof"
    /usr/bin/redis-cli set mode none 
else
    logger "${USB_RESET_SPOOF_FILE} NOT found"
fi

exit 0
