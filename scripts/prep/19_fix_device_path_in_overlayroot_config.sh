#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

MNT_RO=/media/root-ro

mounted_ro=true
findmnt -no OPTIONS $MNT_RO | fgrep -qw 'rw' && mounted_ro=false

$mounted_ro && sudo mount -o remount,rw $MNT_RO
root_rw_dev_path=$(blkid -L root-rw)
sudo sed -i.bak -e "s|LABEL=root-rw|${root_rw_dev_path}|" ${MNT_RO}/etc/overlayroot.local.conf
$mounted_ro && sudo mount -o remount,ro $MNT_RO

exit 0
