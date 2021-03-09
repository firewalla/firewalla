#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

TMP_CRONTAB_FILE=$(mktemp)
cat $CRONTAB_FILE > $TMP_CRONTAB_FILE

for FILE in /home/pi/.firewalla/config/crontab/*; do
  cat $FILE >> $TMP_CRONTAB_FILE
done

USER_CRONTAB=/home/pi/.firewalla/config/user_crontab
if [[ -e $USER_CRONTAB ]]; then
  cat $USER_CRONTAB >> $TMP_CRONTAB_FILE
fi

sudo -u pi crontab -r
sudo -u pi crontab $TMP_CRONTAB_FILE

