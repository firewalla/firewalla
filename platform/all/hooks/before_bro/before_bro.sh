#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

mkdir -p /home/pi/.firewalla/run/zeek/scripts/bro-long-connection
cp $CUR_DIR/bro-long-connection/* /home/pi/.firewalla/run/zeek/scripts/bro-long-connection/
mkdir -p /home/pi/.firewalla/run/zeek/scripts/bro-heartbeat
cp $CUR_DIR/bro-heartbeat/* /home/pi/.firewalla/run/zeek/scripts/bro-heartbeat/
mkdir -p /home/pi/.firewalla/run/zeek/scripts/heartbeat-flow
cp $CUR_DIR/heartbeat-flow/* /home/pi/.firewalla/run/zeek/scripts/heartbeat-flow/
mkdir -p /home/pi/.firewalla/run/zeek/scripts/zeek-conn-log-filter
cp $CUR_DIR/zeek-conn-log-filter/* /home/pi/.firewalla/run/zeek/scripts/zeek-conn-log-filter/
mkdir -p /home/pi/.firewalla/run/zeek/scripts/well-known-server-ports
cp $CUR_DIR/well-known-server-ports/* /home/pi/.firewalla/run/zeek/scripts/well-known-server-ports/
cp $CUR_DIR/dns-mac-logging.zeek /home/pi/.firewalla/run/zeek/scripts/

[[ -e $PLATFORM_HOOK_DIR/broctl.cfg ]] && sudo cp $PLATFORM_HOOK_DIR/broctl.cfg /usr/local/$BRO_PROC_NAME/etc/${BRO_PROC_NAME}ctl.cfg

TMP_FILE="/home/pi/.firewalla/config/local.bro"
ADDITIONAL_FILE="/home/pi/.firewalla/config/additional_options.bro"
if [ -f "${TMP_FILE}" ]; then
  [[ -e $PLATFORM_HOOK_DIR/local.bro ]] && sudo bash -c "cat $PLATFORM_HOOK_DIR/local.bro ${ADDITIONAL_FILE} ${TMP_FILE} > /usr/local/$BRO_PROC_NAME/share/$BRO_PROC_NAME/site/local.$BRO_PROC_NAME"
else
  [[ -e $PLATFORM_HOOK_DIR/local.bro ]] && sudo bash -c "cat $PLATFORM_HOOK_DIR/local.bro ${ADDITIONAL_FILE} > /usr/local/$BRO_PROC_NAME/share/$BRO_PROC_NAME/site/local.$BRO_PROC_NAME"
fi

sync
