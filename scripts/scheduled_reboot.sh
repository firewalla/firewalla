#!/bin/bash
NEXT_REBOOT=$(( $RANDOM%1440+5 ))
logger "FIREWALLA: scheduled reboot in $NEXT_REBOOT minutes"
sudo /sbin/shutdown -r $NEXT_REBOOT
