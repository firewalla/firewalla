#!/bin/bash

CUR_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

[[ -e $CUR_DIR/broctl.cfg ]] && sudo cp $CUR_DIR/broctl.cfg /usr/local/bro/etc/broctl.cfg

TMP_FILE="/home/pi/.firewalla/config/local.bro"
if [ -f "${TMP_FILE}" ]; then
  [[ -e $CUR_DIR/local.bro ]] && sudo bash -c "cat $CUR_DIR/local.bro ${TMP_FILE} > /usr/local/bro/share/bro/site/local.bro"
else
  [[ -e $CUR_DIR/local.bro ]] && sudo cp $CUR_DIR/local.bro /usr/local/bro/share/bro/site/local.bro
fi

sync