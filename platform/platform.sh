#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)

GOLD=gold

case "$UNAME" in
"x86_64")
  source $FW_PLATFORM_DIR/$GOLD/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
  BRO_PROC_NAME="zeek"
  export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
  ;;
"aarch64")
  source $FW_PLATFORM_DIR/blue/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/blue
  BRO_PROC_NAME="bro"
  ;;
"armv7l")
  source $FW_PLATFORM_DIR/red/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/red
  BRO_PROC_NAME="bro"
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

function bro_proc_name {
  echo $BRO_PROC_NAME
}
