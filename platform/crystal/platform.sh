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
# ubuntu26 image ships chrony only, ntpd is not installed
NTP_SVC="chrony"
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

function unsignedModuleAllowed {
  if [[ $(cat /sys/module/module/parameters/sig_enforce 2>/dev/null) == "Y" ]]; then
    return 1
  fi
  if grep -qE '\[(integrity|confidentiality)\]' /sys/kernel/security/lockdown 2>/dev/null; then
    return 1
  fi
  return 0
}

function qdiscPinningDevices {
  local qdisc_kind=$1
  tc qdisc show | awk -v kind="$qdisc_kind" '$2 == kind { for (i = 3; i < NF; i++) if ($i == "dev") print $(i + 1) }' | sort -u
}

function rootQdiscHandle {
  local dev=$1
  tc qdisc show dev "$dev" | awk '$4 == "root" { print $3; exit }'
}

function swapQdiscModule {
  local module_name=$1
  local dst_path=$2
  if ! sudo rmmod "$module_name"; then
    return 1
  fi
  if sudo modprobe "$module_name"; then
    sudo "$TLS_MODULE_ID_SCRIPT" same "$module_name" "$dst_path"
    return $?
  fi
  echo "Failed to load new $module_name, fall back to the original one"
  if [[ -f ${dst_path}.orig ]]; then
    sudo cp "${dst_path}.orig" "$dst_path"
  fi
  sudo modprobe "$module_name"
  return 1
}

function reloadQdiscModule {
  local module_name=$1
  local dst_path=$2
  if ! grep -q "^${module_name} " /proc/modules; then
    return 0
  fi
  sudo "$TLS_MODULE_ID_SCRIPT" same "$module_name" "$dst_path"
  if [[ $? -ne 1 ]]; then
    return 0
  fi

  local ifb_devices=()
  local default_root_devices=()
  local dev
  for dev in $(qdiscPinningDevices "${module_name#sch_}"); do
    if [[ $(rootQdiscHandle "$dev") == "0:" ]]; then
      default_root_devices+=("$dev")
    elif [[ $dev == ifb0 || $dev == ifb1 ]]; then
      ifb_devices+=("$dev")
    else
      echo "Skip reloading $module_name, it is used by a custom root qdisc on $dev"
      return 1
    fi
  done

  for dev in "${ifb_devices[@]}"; do
    sudo tc qdisc del dev "$dev" root
  done
  for dev in "${default_root_devices[@]}"; do
    sudo tc qdisc replace dev "$dev" root pfifo_fast
  done
  swapQdiscModule "$module_name" "$dst_path"
  local result=$?
  for dev in "${default_root_devices[@]}"; do
    sudo tc qdisc del dev "$dev" root
  done
  echo "Reloaded $module_name, result $result"
  return $result
}

function installQdiscModule {
  local module_name=$1
  local ko_path=${FW_PLATFORM_CUR_DIR}/files/kernel_modules/$(uname -r)/${module_name}.ko
  local dst_path=/lib/modules/$(uname -r)/kernel/net/sched/${module_name}.ko
  if [[ ! -f $ko_path ]]; then
    return 0
  fi
  if [[ -f $dst_path && ! -f ${dst_path}.orig ]]; then
    sudo cp "$dst_path" "${dst_path}.orig"
  fi
  if [[ $(sha256sum "$dst_path" 2>/dev/null | awk '{print $1}') != $(sha256sum "$ko_path" | awk '{print $1}') ]]; then
    sudo cp "$ko_path" "$dst_path"
  fi
  if [[ $(realpath -q "$(modinfo -n "$module_name" 2>/dev/null)" 2>/dev/null) != $(realpath "$dst_path") ]]; then
    sudo depmod -a
  fi
  reloadQdiscModule "$module_name" "$dst_path"
}

QDISC_HOTFIX_KERNEL='7.0.6+'

function installSchCakeModule {
  if [[ $(uname -r) != "$QDISC_HOTFIX_KERNEL" ]]; then
    return 0
  fi
  if ! unsignedModuleAllowed; then
    echo "Skip installing qdisc modules, unsigned kernel modules are not allowed"
    return 0
  fi
  installQdiscModule sch_cake
  installQdiscModule sch_fq_codel
}

function map_target_branch {
  case "$1" in
  "release_6_0")
    echo "release_15_0"
    ;;
  "beta_6_0")
    echo "beta_24_0"
    ;;
  "beta_7_0")
    echo "beta_25_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}
