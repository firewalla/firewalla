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
XT_UDP_TLS_SUPPORTED=no
MAX_OLD_SPACE_SIZE=256
HAVE_FWAPC=no
HAVE_FWDAP=no
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

# Flow engines: which program handles each pcap role, decided by two features
#   pcap_zeek_fleet      fleet runs as brofish.service instead of zeek
#   pcap_zeek_suricata   fleet evaluates the suricata rule set instead of suricata
# Same sources as net2/config.js: the runtime value in redis sys:features (set
# by the app / enableDynamicFeature), else the platform's files/config.json
# userFeatures, else net2/config.json, else off. See scripts/fleet-engine.sh.
# net2/config.js merges cloud, MSP and version configuration too, which no
# shell can reproduce; FleetEnginePlugin writes the effective values of the
# features below here whenever they change, and this file is consulted right
# after the runtime overrides in sys:features
FW_EFFECTIVE_FEATURES=${FW_EFFECTIVE_FEATURES:-/dev/shm/fleet-engine.features}

function _fw_feature_on {
  local name=$1 v
  v=$(timeout 3 redis-cli hget sys:features "$name" 2>/dev/null)
  case "$v" in
    1) return 0 ;;
    0) return 1 ;;
  esac
  if [[ -r $FW_EFFECTIVE_FEATURES ]]; then
    v=$(jq -r --arg n "$name" 'if has($n) then (.[$n] | tostring) else empty end' "$FW_EFFECTIVE_FEATURES" 2>/dev/null)
    case "$v" in
      true) return 0 ;;
      false) return 1 ;;
    esac
  fi
  # then the same file precedence as net2/config.js: user config, the platform
  # default, the checked-in default. `has` keeps an explicit false, which
  # `// empty` would have thrown away.
  local cfg
  for cfg in "${FIREWALLA_HIDDEN:-/home/pi/.firewalla}/config/config.json" \
             "${FW_PLATFORM_CUR_DIR:-/nonexistent}/files/config.json" \
             "${FIREWALLA_HOME:-/home/pi/firewalla}/net2/config.json"; do
    [[ -f $cfg ]] || continue
    v=$(jq -r --arg n "$name" 'if (.userFeatures // {}) | has($n) then (.userFeatures[$n] | tostring) else empty end' "$cfg" 2>/dev/null)
    case "$v" in
      true) return 0 ;;
      false) return 1 ;;
    esac
  done
  return 1
}

# the fleet binary arrives as an asset; until it is there (or if it goes
# missing) the roles resolve to the stock engines so the box never ends up
# with neither. Everything shell-side asks these, never the raw feature.
FLEET_BIN=${FLEET_BIN:-/home/pi/.firewalla/run/assets/fleet}

function fleet_available {
  [[ -x $FLEET_BIN ]]
}

function get_flow_engine_zeek {
  if _fw_feature_on pcap_zeek_fleet && fleet_available; then echo fleet; else echo zeek; fi
}

function get_flow_engine_suricata {
  if _fw_feature_on pcap_zeek_suricata && fleet_available; then echo fleet; else echo suricata; fi
}

# the roles themselves can be switched off by the box: pcap_zeek governs flow
# capture and pcap_suricata the IDS, whichever program provides them
function pcap_zeek_enabled {
  _fw_feature_on pcap_zeek
}

function pcap_suricata_enabled {
  _fw_feature_on pcap_suricata
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

function get_tls_ko_path {
  module_name=$1
  if [[ -z $module_name ]]; then
    echo "Error: module_name is empty"
    return 1
  fi
  ko_path=${FW_PLATFORM_CUR_DIR}/files/kernel_modules/$(uname -r)/${module_name}.ko
  echo $ko_path
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
      orange)
        source $FW_PLATFORM_DIR/orange/platform.sh
        FW_PLATFORM_CUR_DIR=$FW_PLATFORM_DIR/orange
        BRO_PROC_NAME="zeek"
        BRO_PROC_COUNT=2
        export ZEEK_DEFAULT_LISTEN_ADDRESS=127.0.0.1
        export FIREWALLA_PLATFORM=orange
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

branch=$(cd /home/pi/firewalla;git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "master" ]; then
  XT_UDP_TLS_SUPPORTED=yes # it's development branch, enable xt_udp_tls for testing
fi


function installTLSModule() {
  uid=$(id -u pi)
  gid=$(id -g pi)
  module_name=$1
  if [[ ${module_name} = "xt_tls" && ${XT_TLS_SUPPORTED} != "yes" ]]; then
    # xt_tls is not supported on this platform ingore
    return 0
  fi
  if [[ ${module_name} = "xt_udp_tls" && ${XT_UDP_TLS_SUPPORTED} != "yes" ]]; then
    # xt_udp_tls is not supported on this platform ingore
    return 0
  fi
  if ! lsmod | grep -wq "${module_name}"; then

    ko_path=$(get_tls_ko_path ${module_name})
    if [[ -z $ko_path ]]; then
      echo "Error: ko_path is empty"
      return 1
    fi

    if [[ -f $ko_path ]]; then
      sudo insmod ${ko_path} max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
    else
      sudo modprobe ${module_name} max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
    fi
    arch=$(uname -m)
    so_path=${FW_PLATFORM_CUR_DIR}/files/shared_objects/$(lsb_release -cs)/lib${module_name}.so
    so_path_alt="/media/root-ro/usr/lib/${arch}-linux-gnu/xtables/lib${module_name}.so"

    if [[ -f $so_path ]]; then
      sudo install -D -v -m 644 ${so_path} /usr/lib/${arch}-linux-gnu/xtables
    elif [[ -f $so_path_alt ]]; then
      sudo install -D -v -m 644 ${so_path_alt} /usr/lib/${arch}-linux-gnu/xtables
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
