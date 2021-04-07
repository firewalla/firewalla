#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

mkdir -p /home/pi/.firewalla/run/zeek/scripts/bro-long-connection
cp $CUR_DIR/bro-long-connection/* /home/pi/.firewalla/run/zeek/scripts/bro-long-connection/

[[ -e $PLATFORM_HOOK_DIR/broctl.cfg ]] && sudo cp $PLATFORM_HOOK_DIR/broctl.cfg /usr/local/bro/etc/broctl.cfg

TMP_FILE="/home/pi/.firewalla/config/local.bro"
ADDITIONAL_FILE="/home/pi/.firewalla/config/additional_options.bro"
if [ -f "${TMP_FILE}" ]; then
  [[ -e $PLATFORM_HOOK_DIR/local.bro ]] && sudo bash -c "cat $PLATFORM_HOOK_DIR/local.bro ${ADDITIONAL_FILE} ${TMP_FILE} > /usr/local/bro/share/bro/site/local.bro"
else
  [[ -e $PLATFORM_HOOK_DIR/local.bro ]] && sudo bash -c "cat $PLATFORM_HOOK_DIR/local.bro ${ADDITIONAL_FILE} > /usr/local/bro/share/bro/site/local.bro"
fi

sync
