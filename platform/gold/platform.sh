MIN_FREE_MEMORY=280
SAFE_MIN_FREE_MEMORY=360
REBOOT_FREE_MEMORY=160
FIREMAIN_MAX_MEMORY=684000
FIREMON_MAX_MEMORY=480000
FIREAPI_MAX_MEMORY=400000
MAX_NUM_OF_PROCESSES=6000
MAX_NUM_OF_THREADS=40000
NODE_VERSION=10.16.3
USB_DEV=/dev/sdb1
MANAGED_BY_FIREBOOT=yes
CRONTAB_FILE=${FIREWALLA_HOME}/etc/crontab.gold
REAL_PLATFORM='real.x86_64'
FW_PROBABILITY="0.99"
FW_QOS_PROBABILITY="0.999"
ALOG_SUPPORTED=yes
FW_SCHEDULE_BRO=false
IFB_SUPPORTED=yes
XT_TLS_SUPPORTED=yes
MANAGED_BY_FIREROUTER=yes
REDIS_MAXMEMORY=400mb
RAMFS_ROOT_PARTITION=yes
FW_ZEEK_RSS_THRESHOLD=800000
MAX_OLD_SPACE_SIZE=512

function get_openssl_cnf_file {
  echo '/etc/openvpn/easy-rsa/openssl.cnf'
}

function heartbeatLED {
  echo hi >> /dev/null
}

function turnOffLED {
  echo hi >> /dev/null
}

function get_node_modules_url {
  echo "https://github.com/firewalla/fnm.node8.x86_64"
}

CURRENT_DIR=$(dirname $BASH_SOURCE)

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
    echo "release_7_0"
    ;;
  "beta_6_0")
    echo "beta_8_0"
    ;;
  "beta_7_0")
    echo "beta_9_0"
    ;;
  "beta_8_0")
    echo "beta_9_0"
    ;;
  "master")
    echo "master"
    ;;
  *)
    echo $1
    ;;
  esac
}

function fw_blink {
  sudo pkill -9 ethtool
  sudo timeout 3600s ethtool -p $1 &
}

function fw_unblink {
  sudo pkill -9 ethtool
}

function installTLSModule {
  uid=$(id -u pi)
  gid=$(id -g pi)
  if ! lsmod | grep -wq "xt_tls"; then
    if [[ $(lsb_release -cs) == "focal" ]]; then
      sudo insmod ${FW_PLATFORM_CUR_DIR}/files/TLS/u20/xt_tls.ko max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
      sudo install -D -v -m 644 ${FW_PLATFORM_CUR_DIR}/files/TLS/u20/libxt_tls.so /usr/lib/x86_64-linux-gnu/xtables
    else
      sudo insmod ${FW_PLATFORM_CUR_DIR}/files/TLS/u18/xt_tls.ko max_host_sets=1024 hostset_uid=${uid} hostset_gid=${gid}
      sudo install -D -v -m 644 ${FW_PLATFORM_CUR_DIR}/files/TLS/u18/libxt_tls.so /usr/lib/x86_64-linux-gnu/xtables
    fi
  fi
}