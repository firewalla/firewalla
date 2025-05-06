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
HAVE_FWAPC=no
WAN_INPUT_DROP_RATE_LIMIT=10

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

function get_cloud_endpoint {
  RELEASE_TYPE=$(get_release_type)
  if [ "$RELEASE_TYPE" = "dev" -o "$RELEASE_TYPE" = "unknown" ]; then
    echo "https://ota.firewalla.com/dev"
  else
    echo "https://ota.firewalla.com"
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

function get_dynamic_assets_list {
  echo ""
}

function get_profile_default_name {
  echo "profile_default"
}

function beep {
  return
}

case "$UNAME" in
  "x86_64")
    if [[ -e /etc/firewalla-release ]]; then
      BOARD=$( . /etc/firewalla-release 2>/dev/null && echo $BOARD || cat /etc/firewalla-release )
    else
      BOARD='unknown'
    fi
    case $BOARD in
      gold-pro)
        source $FW_PLATFORM_DIR/goldpro/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/goldpro
        export FIREWALLA_PLATFORM=goldpro
        ;;
      *)
        source $FW_PLATFORM_DIR/gold/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/gold
        export FIREWALLA_PLATFORM=gold
        ;;
    esac
    BRO_PROC_NAME="zeek"
    BRO_PROC_COUNT=6
    export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
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

function installTLSModule() {
  uid=$(id -u pi)
  gid=$(id -g pi)
  module_name=$1
  if ! lsmod | grep -wq "${module_name}"; then
    ko_path=${FW_PLATFORM_CUR_DIR}/files/kernel_modules/$(uname -r)/${module_name}.ko
    if [[ -f $ko_path ]]; then
      sudo insmod ${ko_path} max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
    fi
    so_path=${FW_PLATFORM_CUR_DIR}/files/shared_objects/$(lsb_release -cs)/lib${module_name}.so
    if [[ -f $so_path ]]; then
      sudo install -D -v -m 644 ${so_path} /usr/lib/$(uname -m)-linux-gnu/xtables
    fi
  fi
  return
}

function installSchCakeModule {
  ko_path=${FW_PLATFORM_CUR_DIR}/files/kernel_modules/$(uname -r)/sch_cake.ko
  if [[ -f $ko_path ]]; then
    if ! modinfo sch_cake > /dev/null || [[ $(sha256sum /lib/modules/$(uname -r)/kernel/net/sched/sch_cake.ko | awk '{print $1}') != $(sha256sum $ko_path | awk '{print $1}') ]]; then
      sudo cp ${ko_path} /lib/modules/$(uname -r)/kernel/net/sched/
      sudo depmod -a
    fi
  fi

  tc_path=${FW_PLATFORM_CUR_DIR}/files/executables/$(lsb_release -cs)/tc
  tc_dst_path=$(which tc || echo "/sbin/tc")
  if [[ -f $tc_path ]]; then
    if [[ $(sha256sum $tc_dst_path | awk '{print $1}') != $(sha256sum $tc_path | awk '{print $1}') ]]; then
      sudo cp $tc_path $tc_dst_path
    fi
  fi
  return
}

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
