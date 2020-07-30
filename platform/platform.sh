#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)

# by default no
MANAGED_BY_FIREBOOT=no
FIREWALLA_PLATFORM=unknown

case "$UNAME" in
  "x86_64")
    source $FW_PLATFORM_DIR/gold/platform.sh
    FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
    BRO_PROC_NAME="zeek"
    BRO_PROC_COUNT=6
    export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
    FIREWALLA_PLATFORM=gold
    ;;
  "aarch64")
    if [[ -e /etc/firewalla-release ]]; then
      BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      BOARD='unknown'
    fi
    case $BOARD in
      navy)
        source $FW_PLATFORM_DIR/navy/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/navy
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        FIREWALLA_PLATFORM=navy
        ;;
      blue)
        source $FW_PLATFORM_DIR/blue/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/blue
        BRO_PROC_NAME="bro"
        BRO_PROC_COUNT=3
        FIREWALLA_PLATFORM=blue
        ;;
      *)
        unset FW_PLATFORM_CUR_DIR
        unset BRO_PROC_NAME
        unset BRO_PROC_COUNT
        unset ZEEK_DEFAULT_LISTEN_ADDRESS
        ;;
    esac
    ;;
  "armv7l")
    source $FW_PLATFORM_DIR/red/platform.sh
    FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/red
    BRO_PROC_NAME="bro"
    BRO_PROC_COUNT=3
    FIREWALLA_PLATFORM=red
    ;;
  *)
    ;;
esac


function before_bro {
  if [[ -d ${FW_PLATFORM_CUR_DIR}/hooks/before_bro ]]; then
    for script in `ls -1 ${FW_PLATFORM_CUR_DIR}/hooks/before_bro/*.sh`; do
      $script
    done
  fi
}
