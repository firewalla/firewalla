#!/bin/bash
NEXT_REBOOT=$(( $RANDOM%1440+5 ))
logger "FIREWALLA: scheduled reboot in $NEXT_REBOOT minutes"
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ $branch =~ release.* ]]; then
    touch /home/pi/.firewalla/managed_reboot
    sync
fi
sync
sudo /sbin/shutdown -r $NEXT_REBOOT
