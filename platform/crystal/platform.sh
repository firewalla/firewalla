# Crystal platform shell config (firewalla side)
#
# Crystal is a pure-software, x86_64 product (no fixed hardware). Values here are
# modeled on goldpro/gold (the closest x86_64 reference) but with every hardware
# assumption removed: no LEDs, no fan, no beeper, no firestatus daemon.
#
# This file is sourced by platform/platform.sh when BOARD=crystal. The base
# defaults / shared functions are defined there before this is sourced.

MIN_FREE_MEMORY=280
SAFE_MIN_FREE_MEMORY=360
REBOOT_FREE_MEMORY=160
FIREMAIN_MAX_MEMORY=684000
FIREMON_MAX_MEMORY=480000
FIREAPI_MAX_MEMORY=400000
MAX_NUM_OF_PROCESSES=6000
MAX_NUM_OF_THREADS=40000
NODE_VERSION=10.16.3
MANAGED_BY_FIREBOOT=yes
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.crystal
REAL_PLATFORM='real.x86_64'
FW_PROBABILITY="0.999"
FW_QOS_PROBABILITY="0.999"
ALOG_SUPPORTED=yes
FW_SCHEDULE_BRO=false
IFB_SUPPORTED=yes
XT_TLS_SUPPORTED=yes
MANAGED_BY_FIREROUTER=yes
REDIS_MAXMEMORY=600mb
RAMFS_ROOT_PARTITION=yes
FW_ZEEK_RSS_THRESHOLD=800000
MAX_OLD_SPACE_SIZE=512
HAVE_FWAPC=yes
HAVE_FWDAP=yes
WAN_INPUT_DROP_RATE_LIMIT=16

# Crystal has no physical status LEDs and no firestatus daemon.
NEED_FIRESTATUS=false

CURRENT_DIR=$(dirname $BASH_SOURCE)
CGROUP_SOCK_MARK=${CURRENT_DIR}/files/cgroup_sock_mark

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl.cnf'
}

# No LEDs on Crystal.
function heartbeatLED {
  echo hi >> /dev/null
}

function turnOffLED {
  echo hi >> /dev/null
}

# No beeper on Crystal.
function beep {
  return
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node8.x86_64"
}

function get_brofish_service {
  echo "${CURRENT_DIR}/files/brofish.service"
}

function get_openvpn_service {
  echo "${CURRENT_DIR}/files/openvpn@.service"
}

function get_suricata_service {
  echo "${CURRENT_DIR}/files/suricata.service"
}

function get_sysctl_conf_path {
  echo "${CURRENT_DIR}/files/sysctl.conf"
}

function get_dynamic_assets_list {
  echo "${CURRENT_DIR}/files/assets.lst"
}

function get_node_bin_path {
  echo "/home/pi/.nvm/versions/node/v12.14.0/bin/node"
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_12_0"
    ;;
  "beta_6_0")
    echo "beta_18_0"
    ;;
  "beta_7_0")
    echo "beta_19_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}
