#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)

case "$UNAME" in
"x86_64")
  source $FW_PLATFORM_DIR/docker/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/docker
  ;;
"aarch64")
  source $FW_PLATFORM_DIR/blue/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/blue
  ;;
"armv7l")
  source $FW_PLATFORM_DIR/red/platform.sh
  FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/red
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