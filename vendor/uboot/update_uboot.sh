#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FW_DEVICE:=/dev/mmcblk0}
: ${FW_DEBUG:=no}

write_uboot_platform () {
	dd if=/dev/zero of=$2 bs=1k count=1023 seek=1 status=noxfer &>/dev/null  && \
	dd if=$1 of=$2 bs=1024 seek=8 status=noxfer &>/dev/null
	if [[ $? == 0 && $FW_DEBUG == "yes" ]]; then
		echo "Uboot patched successfully";
	fi
}

UBOOT_FILE_DIRECTORY=$FIREWALLA_HOME/vendor/uboot
UBOOT_FILE=${UBOOT_FILE_DIRECTORY}/u-boot-sunxi-with-spl.bin

if [[ $(id -u) != 0 ]]; then
  echo "ERROR: require root privilege"
  exit 2
fi
if ! grep -q 'BOARD_NAME="NanoPi Neo"' /etc/armbian-release; then
  echo "ERROR: only support naoopi neo chip"
  exit 1
fi

if [[ -e $UBOOT_FILE && -e $FW_DEVICE ]]; then
  write_uboot_platform $UBOOT_FILE $FW_DEVICE
else
  if [[ ! -e $UBOOT_FILE ]]; then
    echo "ERROR: uboot file $UBOOT_FILE not found"
  fi

  if [[ ! -e $FW_DEVICE ]]; then
    echo "ERROR: device $FW_DEVICE not found"
  fi
fi

sync
sync
sync