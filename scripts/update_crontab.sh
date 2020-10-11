#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

USER_CRONTAB=/home/pi/.firewalla/config/user_crontab
if [[ -e $USER_CRONTAB ]]; then
    sudo -u pi crontab -r ; 
    TMP_CRONTAB_FILE=$(mktemp)
    cat $CRONTAB_FILE > $TMP_CRONTAB_FILE
    cat $USER_CRONTAB >> $TMP_CRONTAB_FILE
    sudo -u pi crontab $TMP_CRONTAB_FILE
else
    sudo -u pi crontab -r ; sudo -u pi crontab $CRONTAB_FILE
fi