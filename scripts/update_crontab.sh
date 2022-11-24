#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

TMP_CRONTAB_FILE=$(mktemp)
cat $CRONTAB_FILE > $TMP_CRONTAB_FILE

sudo -u pi mkdir -p $FIREWALLA_HIDDEN/config/crontab

(cd $FIREWALLA_HIDDEN/config/crontab
for FILE in $(ls); do
  cat $FILE >> $TMP_CRONTAB_FILE
done
)

USER_CRONTAB=$FIREWALLA_HIDDEN/config/user_crontab
if [[ -f $USER_CRONTAB ]]; then
  cat $USER_CRONTAB >> $TMP_CRONTAB_FILE
fi

ZEEK_CRONTAB=$FIREWALLA_HIDDEN/config/zeek_crontab
if [[ -f $ZEEK_CRONTAB ]]; then
  cat $ZEEK_CRONTAB >> $TMP_CRONTAB_FILE
fi

SURICATA_CRONTAB=$FIREWALLA_HIDDEN/config/suricata_crontab
if [[ -f $SURICATA_CRONTAB ]]; then
  cat $SURICATA_CRONTAB >> $TMP_CRONTAB_FILE
fi

sudo -u pi crontab -r
sudo -u pi crontab $TMP_CRONTAB_FILE

if [[ $? -ne 0 ]]; then
  logger "Failed to update crontab, please validate format of user crontab $FIREWALLA_HIDDEN/config/user_contab. Falling back to system crontab $CRONTAB_FILE ..."
  cat $CRONTAB_FILE > $TMP_CRONTAB_FILE
  ( cd $FIREWALLA_HIDDEN/config/crontab
  for FILE in $(ls); do
    cat $FILE >> $TMP_CRONTAB_FILE
  done
  )
  sudo -u pi crontab $TMP_CRONTAB_FILE
fi

sudo systemctl restart cron
rm $TMP_CRONTAB_FILE
