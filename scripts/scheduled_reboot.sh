#!/bin/bash

if [[ -e "/home/pi/.firewalla/config/.no_scheduled_reboot" ]]; then
  /home/pi/firewalla/scripts/firelog -t cloud -m "FIREWALLA.REBOOT SCHEDULED REBOOT IS DISABLED"
  exit 0
fi

if [ ! -f /tmp/PRODUCTION ]; then
  /home/pi/firewalla/scripts/firelog -t cloud -m "FIREWALLA.REBOOT SCHEDULED REBOOT IS DISABLED FOR MASTER"
  exit 0
fi

mode=$(redis-cli get mode)

if [ "$mode" == "dhcp" ]; then
  touch /home/pi/.firewalla/managed_reboot
  sync
  /home/pi/firewalla/scripts/firelog -t cloud -m "FIREWALLA.REBOOT SCHEDULED REBOOT IS DISABLED FOR DHCP MODE"
  exit 0
fi 

NEXT_REBOOT=$(( $RANDOM%1440+5 ))
logger "FIREWALLA: scheduled reboot in $NEXT_REBOOT minutes"
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ $branch =~ release.* ]]; then
    touch /home/pi/.firewalla/managed_reboot
    sync
fi
sync
sudo /sbin/shutdown -r $NEXT_REBOOT
