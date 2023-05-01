#!/bin/bash

FW_PLATFORM_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"

UNAME=$(uname -m)

# by default no
MANAGED_BY_FIREBOOT=no
export FIREWALLA_PLATFORM=unknown
TCP_BBR=no
FW_PROBABILITY="0.9"
FW_SCHEDULE_BRO=true
IFB_SUPPORTED=no
MANAGED_BY_FIREROUTER=no
REDIS_MAXMEMORY=300mb
RAMFS_ROOT_PARTITION=no
XT_TLS_SUPPORTED=no
MAX_OLD_SPACE_SIZE=256

hook_server_route_up() {
  echo nothing > /dev/null
}

function hook_after_vpn_confgen {
  # by default do nothing
  OVPN_CFG="$1"
  echo nothing > /dev/null
}

function restart_bluetooth_service() {
  return
}

function get_release_type {
  NODE=$(get_node_bin_path)
  (
    cd /home/pi/firewalla
    $NODE -e 'const firewalla = require("./net2/Firewalla.js"); console.log(firewalla.getReleaseType()); process.exit()'
  )
}

function get_assets_prefix {
  RELEASE_TYPE=$(get_release_type)
  if [ "$RELEASE_TYPE" = "dev" -o "$RELEASE_TYPE" = "unknown" ]; then 
    echo "https://fireupgrade.s3.us-west-2.amazonaws.com/dev"
  elif [ "$RELEASE_TYPE" = "alpha" ]; then
    echo "https://fireupgrade.s3.us-west-2.amazonaws.com/alpha"
  else
    echo "https://fireupgrade.s3.us-west-2.amazonaws.com"
  fi
}

function get_node_bin_path {
  if [[ -e /home/pi/.nvm/versions/node/v12.18.3/bin/node ]] && fgrep -qi navy /etc/firewalla-release; then
    echo "/home/pi/.nvm/versions/node/v12.18.3/bin/node"
  elif [[ -e /home/pi/.nvm/versions/node/v8.7.0/bin/node ]]; then
    echo "/home/pi/.nvm/versions/node/v8.7.0/bin/node"
  elif [[ -e /home/pi/.nvm/versions/node/v12.14.0/bin/node && $(uname -m) == "x86_64" ]]; then
    echo "/home/pi/.nvm/versions/node/v12.14.0/bin/node"
  elif [[ -d ~/.nvm ]]; then
    . ~/.nvm/nvm.sh &> /dev/null
    echo $(nvm which current)
  else
    # Use system one
    echo $(which node)
  fi
}

function get_zeek_log_dir {
  echo "/log/blog/"
}

function heartbeatLED {
  return 0
}

function turnOffLED {
  return 0
}

function led_boot_state() {
  return 0
}

function installTLSModule {
  return
}

function installSchCakeModule {
  return
}

function get_dynamic_assets_list {
  echo ""
}

function get_profile_default_name {
  echo "profile_default"
}

case "$UNAME" in
  "x86_64")
    source $FW_PLATFORM_DIR/gold/platform.sh
    FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
    BRO_PROC_NAME="zeek"
    BRO_PROC_COUNT=6
    export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
    export FIREWALLA_PLATFORM=gold
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
        export FIREWALLA_PLATFORM=navy
        ;;
      purple)
        source $FW_PLATFORM_DIR/purple/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/purple
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        export FIREWALLA_PLATFORM=purple
        ;;
      purple-se)
        source $FW_PLATFORM_DIR/pse/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/pse
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        export FIREWALLA_PLATFORM=pse
        ;;
      gold-se)
        source $FW_PLATFORM_DIR/gse/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gse
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        export FIREWALLA_PLATFORM=gse
        ;;
      blue)
        source $FW_PLATFORM_DIR/blue/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/blue
        BRO_PROC_NAME="bro"
        BRO_PROC_COUNT=3
        export FIREWALLA_PLATFORM=blue
        ;;
      ubt)
        source $FW_PLATFORM_DIR/ubt/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/ubt
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        export FIREWALLA_PLATFORM=ubt
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
    export FIREWALLA_PLATFORM=red
    ;;
  *)
    ;;
esac


function before_bro {
  if [[ -d ${FW_PLATFORM_DIR}/all/hooks/before_bro ]]; then
    for script in `ls -1 ${FW_PLATFORM_DIR}/all/hooks/before_bro/*.sh`; do
      BRO_PROC_NAME="$BRO_PROC_NAME" PLATFORM_HOOK_DIR="$FW_PLATFORM_CUR_DIR/hooks/before_bro" $script
    done
  fi

  if [[ -d ${FW_PLATFORM_CUR_DIR}/hooks/before_bro ]]; then
    for script in `ls -1 ${FW_PLATFORM_CUR_DIR}/hooks/before_bro/*.sh`; do
      $script
    done
  fi
}

function after_bro {
  if [[ -d ${FW_PLATFORM_DIR}/all/hooks/after_bro ]]; then
    for script in `ls -1 ${FW_PLATFORM_DIR}/all/hooks/after_bro/*.sh`; do
      BRO_PROC_NAME="$BRO_PROC_NAME" PLATFORM_HOOK_DIR="$FW_PLATFORM_CUR_DIR/hooks/after_bro" $script
    done
  fi

  if [[ -d ${FW_PLATFORM_CUR_DIR}/hooks/after_bro ]]; then
    for script in `ls -1 ${FW_PLATFORM_CUR_DIR}/hooks/after_bro/*.sh`; do
      $script
    done
  fi
}

######### do not add function here!!! functions in base class should be defined before source each individual platform scripts #########
